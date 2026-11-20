use quote::ToTokens;
use sha2::{Digest, Sha256};

fn main() {
    // Tokenize instead of hashing text: comments, documentation and rustfmt cannot cause a wave.
    // Keep unrelated protocol/diagnostic/UI/server changes out of the decoder identity.
    let mut hash = Sha256::new();
    for path in [
        "src/decode.rs",
        "src/capture.rs",
        "src/lib.rs",
        "src/main.rs",
    ] {
        println!("cargo:rerun-if-changed={path}");
        let source = std::fs::read_to_string(path).expect("decoder source");
        let mut syntax = syn::parse_file(&source).expect("valid decoder Rust");
        if path.ends_with("decode.rs") {
            assert!(
                !syntax
                    .items
                    .iter()
                    .any(|item| matches!(item, syn::Item::Mod(_))),
                "Register extracted decoder modules in build.rs before moving decoding into them"
            );
        }
        if path.ends_with("main.rs") {
            // Input validation, streaming and header sniffing can change acceptance too, but
            // socket setup, identity responses and admission bookkeeping cannot change decoding.
            syntax
                .items
                .retain(|item| matches!(item, syn::Item::Fn(item) if item.sig.ident == "derive"));
        }
        if path.ends_with("lib.rs") {
            syntax.items.retain(|item| match item {
                syn::Item::Const(item) => matches!(
                    item.ident.to_string().as_str(),
                    "MAX_INPUT"
                        | "MAX_OUTPUT"
                        | "MAX_DISPLAY_OUTPUT"
                        | "MAX_PIXELS"
                        | "VIDEO_SAMPLE_HEAD"
                        | "VIDEO_SAMPLE_TAIL"
                        | "MAX_VIDEO_SIZE"
                        | "CAPTURE_IMAGE_PREFIX"
                        | "EDGE"
                        | "DISPLAY_EDGE"
                ),
                syn::Item::Enum(item) => item.ident == "Format",
                syn::Item::Impl(item) => item.self_ty.to_token_stream().to_string() == "Format",
                syn::Item::Fn(item) => matches!(
                    item.sig.ident.to_string().as_str(),
                    "webp_dimensions" | "display_dimensions" | "webp_dimensions_within"
                ),
                _ => false,
            });
        }
        // Documentation attributes do not affect decoding either.
        for item in &mut syntax.items {
            let attrs = match item {
                syn::Item::Fn(item) => &mut item.attrs,
                syn::Item::Const(item) => &mut item.attrs,
                syn::Item::Enum(item) => &mut item.attrs,
                syn::Item::Impl(item) => &mut item.attrs,
                _ => continue,
            };
            attrs.retain(|attr| !attr.path().is_ident("doc"));
        }
        hash.update(syntax.to_token_stream().to_string());
    }
    println!("cargo:rustc-env=HYORI_DECODER_SOURCE={:x}", hash.finalize());
}
