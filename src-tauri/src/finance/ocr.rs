//! Receipt OCR, using the text recogniser the operating system already ships.
//!
//! The finance capture flow prefers a vision model. When the model the user
//! picked cannot see images, the receipt still has to become text somehow — and
//! that fallback has to work the moment Nomi is installed. So instead of
//! bundling an OCR engine (or asking the user to `brew install tesseract`), this
//! module calls the recogniser that is already part of the OS:
//!
//! * macOS — `Vision.framework`'s `VNRecognizeTextRequest` (since 10.15;
//!   Simplified Chinese since 11.0).
//! * Windows — `Windows.Media.Ocr.OcrEngine` (since Windows 10), using the
//!   languages installed for the user's profile.
//!
//! Both are offline, need no download, and handle Chinese receipts well. On any
//! other platform [`recognize`] reports that no engine is available, and the
//! caller turns that into a "pick a vision model" message rather than failing
//! silently.

/// Human-readable name of the engine that would run, for the UI to explain what
/// happened ("已用 macOS 内置文字识别读出小票文本").
pub fn engine_name() -> &'static str {
    #[cfg(target_os = "macos")]
    {
        "macOS 内置文字识别"
    }
    #[cfg(target_os = "windows")]
    {
        "Windows 内置文字识别"
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        "无"
    }
}

/// Whether this platform has an OCR engine at all. `false` means the user must
/// choose a vision-capable model.
pub fn available() -> bool {
    cfg!(any(target_os = "macos", target_os = "windows"))
}

/// Read the text out of an encoded image (PNG / JPEG bytes). Returns the
/// recognised lines joined by newlines, in reading order.
///
/// The bytes must be an *opaque* image: macOS Vision returns zero observations
/// for a PNG whose background is transparent, so callers pass images that have
/// already been through [`super::store::normalize_image`].
///
/// Blocking and CPU-bound — call it from `spawn_blocking`.
pub fn recognize(image_bytes: &[u8]) -> Result<String, String> {
    if image_bytes.is_empty() {
        return Err("图片为空，无法识别。".into());
    }
    recognize_impl(image_bytes)
}

#[cfg(target_os = "macos")]
fn recognize_impl(image_bytes: &[u8]) -> Result<String, String> {
    use objc2::AnyThread;
    use objc2::rc::Retained;
    use objc2_foundation::{NSArray, NSData, NSDictionary, NSString};
    use objc2_vision::{
        VNImageRequestHandler, VNRecognizeTextRequest, VNRequestTextRecognitionLevel,
    };

    let data = NSData::with_bytes(image_bytes);

    let request = VNRecognizeTextRequest::new();
    request.setRecognitionLevel(VNRequestTextRecognitionLevel::Accurate);
    // Receipts are short strings of names, amounts and dates rather than prose;
    // language correction helps the Chinese merchant names and hurts nothing.
    request.setUsesLanguageCorrection(true);
    // Ordered by preference. A Chinese receipt is mostly 汉字 with ASCII digits,
    // so both languages have to be on for the amounts to come out right.
    let languages = NSArray::from_retained_slice(&[
        NSString::from_str("zh-Hans"),
        NSString::from_str("zh-Hant"),
        NSString::from_str("en-US"),
    ]);
    request.setRecognitionLanguages(&languages);
    // Vision ignores text shorter than 1/32 of the image height by default, which
    // silently drops everything on a tall screenshot whose receipt block is small.
    // 0 turns the filter off and lets the detector decide.
    // Vision ignores text shorter than 1/32 of the image height by default, which
    // drops the whole receipt when it sits in a corner of a tall screenshot.
    // 0 turns the filter off and lets the detector decide.
    request.setMinimumTextHeight(0.0);

    let handler = VNImageRequestHandler::initWithData_options(
        VNImageRequestHandler::alloc(),
        &data,
        &NSDictionary::new(),
    );
    // Two hops up the class chain: VNRecognizeTextRequest → VNImageBasedRequest → VNRequest.
    let requests = NSArray::from_retained_slice(&[Retained::into_super(Retained::into_super(
        request.clone(),
    ))]);
    handler
        .performRequests_error(&requests)
        .map_err(|error| format!("系统文字识别失败：{error}"))?;

    let mut lines: Vec<String> = Vec::new();
    if let Some(results) = request.results() {
        for observation in results.iter() {
            // One candidate is enough: the top one is what Vision itself would
            // show, and a receipt has no context for us to re-rank with.
            if let Some(text) = observation.topCandidates(1).firstObject() {
                let line = text.string().to_string();
                if !line.trim().is_empty() {
                    lines.push(line);
                }
            }
        }
    }
    Ok(lines.join("\n"))
}

#[cfg(target_os = "windows")]
fn recognize_impl(image_bytes: &[u8]) -> Result<String, String> {
    use windows::Graphics::Imaging::BitmapDecoder;
    use windows::Media::Ocr::OcrEngine;
    use windows::Storage::Streams::{DataWriter, InMemoryRandomAccessStream};

    fn win(error: windows::core::Error) -> String {
        format!("系统文字识别失败：{error}")
    }

    // WinRT decodes from a random-access stream, so the bytes are copied into an
    // in-memory one first.
    let stream = InMemoryRandomAccessStream::new().map_err(win)?;
    let writer = DataWriter::CreateDataWriter(&stream).map_err(win)?;
    writer.WriteBytes(image_bytes).map_err(win)?;
    writer.StoreAsync().map_err(win)?.join().map_err(win)?;
    writer.FlushAsync().map_err(win)?.join().map_err(win)?;
    writer.DetachStream().map_err(win)?;
    stream.Seek(0).map_err(win)?;

    let decoder = BitmapDecoder::CreateAsync(&stream)
        .map_err(win)?
        .join()
        .map_err(win)?;
    let bitmap = decoder
        .GetSoftwareBitmapAsync()
        .map_err(win)?
        .join()
        .map_err(win)?;

    // Uses whatever OCR languages the profile has installed. On a system with no
    // OCR language pack this returns null, which the `windows` crate surfaces as
    // an error — turned into an actionable message rather than a raw HRESULT.
    let engine = OcrEngine::TryCreateFromUserProfileLanguages().map_err(|_| {
        "Windows 没有可用的文字识别语言包，请在「设置 → 时间和语言」中添加中文语言包，或改用支持视觉的模型。".to_string()
    })?;
    let result = engine
        .RecognizeAsync(&bitmap)
        .map_err(win)?
        .join()
        .map_err(win)?;
    Ok(result.Text().map_err(win)?.to_string())
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn recognize_impl(_image_bytes: &[u8]) -> Result<String, String> {
    Err("当前系统没有内置文字识别，请选择一个支持视觉的模型。".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Round-trips a real image through the platform engine. Skipped unless
    /// `NOMI_OCR_TEST_IMAGE` points at one, since CI runners have no fixture and
    /// the OS engines cannot be stubbed.
    #[test]
    fn reads_text_from_a_real_image() {
        let Ok(path) = std::env::var("NOMI_OCR_TEST_IMAGE") else {
            return;
        };
        let bytes = std::fs::read(&path).expect("fixture image");
        let text = recognize(&bytes).expect("ocr");
        assert!(!text.trim().is_empty(), "engine returned nothing");
        println!("--- OCR ---\n{text}\n--- end ---");
    }

    #[test]
    fn rejects_empty_input() {
        assert!(recognize(&[]).is_err());
    }
}
