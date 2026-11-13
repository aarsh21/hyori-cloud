use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    io::{self, Read},
    process::Command,
};

/// Decoder tokens plus the actual FFmpeg executables and their transitive shared libraries.
/// Neither package-ledger noise nor image IDs/timestamps participate. Stream library bytes so
/// startup remains bounded in the isolated worker's memory budget.
pub fn fingerprint() -> io::Result<String> {
    let mut hash = Sha256::new();
    hash.update(env!("HYORI_DECODER_SOURCE"));
    let mut files = BTreeSet::new();
    for binary in ["/usr/bin/ffprobe", "/usr/bin/ffmpeg"] {
        files.insert(binary.to_owned());
        let linked = Command::new("/usr/bin/ldd")
            .arg(binary)
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("LC_ALL", "C")
            .output()?;
        if !linked.status.success() {
            return Err(io::Error::other("cannot identify decoder libraries"));
        }
        for line in String::from_utf8_lossy(&linked.stdout).lines() {
            // ldd emits either `name => /path (address)` or `/loader (address)`.
            if let Some(path) = line.split_whitespace().find(|word| word.starts_with('/')) {
                files.insert(path.to_owned());
            }
        }
    }
    for path in files {
        let mut file = std::fs::File::open(&path)?;
        hash.update(path.as_bytes());
        hash.update(file.metadata()?.len().to_le_bytes());
        let mut buffer = [0; 8192];
        loop {
            let length = file.read(&mut buffer)?;
            if length == 0 {
                break;
            }
            hash.update(&buffer[..length]);
        }
    }
    Ok(format!("{:x}", hash.finalize()))
}
