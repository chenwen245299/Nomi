//! The plain OpenAI-compatible baseline: `openai` / `kimi` / `ollama` / `custom`
//! and any unknown kind resolve here. It overrides nothing — every hook uses the
//! [`ProviderSpec`] default — so this module is the living definition of "no
//! provider-specific behaviour".

use super::spec::ProviderSpec;

pub(crate) struct OpenAiCompatible;

impl ProviderSpec for OpenAiCompatible {}
