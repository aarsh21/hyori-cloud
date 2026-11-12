use std::{env, fs, path::PathBuf};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let tooling = PathBuf::from(env::var("CARGO_MANIFEST_DIR")?).join("../../tooling/artcraft");
    println!("cargo:rerun-if-changed={}", tooling.display());
    let mut authorities = fs::read_dir(&tooling)?
        .map(|entry| entry.map(|entry| entry.path()))
        .collect::<Result<Vec<_>, _>>()?;
    authorities.retain(|path| {
        path.file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with("runtime-native-v3") && name.ends_with(".json"))
    });
    // The unsuffixed authority is r1; numeric revisions must not sort r10 before r2.
    let mut revisions = authorities
        .into_iter()
        .map(|path| {
            let stem = path
                .file_stem()
                .and_then(|name| name.to_str())
                .unwrap_or("");
            let revision = if stem == "runtime-native-v3" {
                1
            } else {
                stem.strip_prefix("runtime-native-v3-r")
                    .ok_or("invalid native authority filename")?
                    .parse::<u32>()?
            };
            Ok((revision, path))
        })
        .collect::<Result<Vec<_>, Box<dyn std::error::Error>>>()?;
    revisions.sort_by_key(|(revision, _)| *revision);
    if revisions.is_empty() {
        return Err("at least one committed native editor authority is required".into());
    }
    let entries = revisions
        .iter()
        .map(|(_, path)| format!("include_str!({:?}),", path))
        .collect::<String>();
    fs::write(
        PathBuf::from(env::var("OUT_DIR")?).join("native_authorities.rs"),
        format!("const NATIVE_AUTHORITIES: &[&str] = &[{entries}];"),
    )?;
    Ok(())
}
