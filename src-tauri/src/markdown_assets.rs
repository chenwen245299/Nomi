use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use tauri::ipc::{InvokeBody, Request};

const OWNER_HEADER: &str = "x-nomi-owner";
const NAME_HEADER: &str = "x-nomi-file-name";

fn decode_header(request: &Request<'_>, name: &str) -> Result<String, String> {
    let encoded = request
        .headers()
        .get(name)
        .ok_or_else(|| "图片请求缺少元数据。".to_string())?
        .to_str()
        .map_err(|_| "图片请求元数据无效。".to_string())?;
    let bytes = URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|_| "图片请求元数据无法解码。".to_string())?;
    String::from_utf8(bytes).map_err(|_| "图片请求元数据不是 UTF-8。".to_string())
}

/// Extract the owner, original filename and unencoded image bytes from a raw IPC
/// request. Only the two short strings use headers; the large payload stays binary.
pub(crate) fn parse_write_request<'a>(
    request: &'a Request<'_>,
) -> Result<(String, String, &'a [u8]), String> {
    let owner = decode_header(request, OWNER_HEADER)?;
    let name = decode_header(request, NAME_HEADER)?;
    let bytes = match request.body() {
        InvokeBody::Raw(bytes) => bytes.as_slice(),
        InvokeBody::Json(_) => return Err("图片必须以二进制方式传输。".into()),
    };
    if bytes.is_empty() {
        return Err("图片内容为空。".into());
    }
    Ok((owner, name, bytes))
}
