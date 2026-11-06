use std::{fs, io};

/// Refuse to decode outside the supported locked-down Linux container deployment.
pub fn verify() -> io::Result<()> {
    let status = fs::read_to_string("/proc/self/status")?;
    let value = |key: &str| {
        status
            .lines()
            .find_map(|line| line.strip_prefix(key))
            .map(str::trim)
    };
    let uid = value("Uid:")
        .and_then(|v| v.split_whitespace().nth(1))
        .and_then(|v| v.parse::<u32>().ok());
    let mounts = fs::read_to_string("/proc/self/mountinfo")?;
    let root_ro = mounts.lines().any(|line| {
        let fields: Vec<_> = line.split_whitespace().collect();
        fields.get(4) == Some(&"/")
            && fields
                .get(5)
                .is_some_and(|v| v.split(',').any(|v| v == "ro"))
    });
    let scratch_tmpfs = mounts.lines().any(|line| {
        line.split_whitespace().nth(4) == Some("/scratch")
            && line.split_whitespace().nth(5).is_some_and(|flags| {
                flags.split(',').any(|f| f == "noexec") && flags.split(',').any(|f| f == "nosuid")
            })
            && line.split(" - ").nth(1).is_some_and(|tail| {
                tail.starts_with("tmpfs ")
                    && tail.split_whitespace().nth(2).is_some_and(|flags| {
                        flags
                            .split(',')
                            .filter_map(|f| f.strip_prefix("size="))
                            .any(|size| {
                                let (value, multiplier) = if let Some(v) = size.strip_suffix('k') {
                                    (v, 1024_u64)
                                } else if let Some(v) = size.strip_suffix('m') {
                                    (v, 1024_u64 * 1024)
                                } else {
                                    (size, 1)
                                };
                                value
                                    .parse::<u64>()
                                    .ok()
                                    .and_then(|v| v.checked_mul(multiplier))
                                    .is_some_and(|bytes| bytes <= 96 * 1024 * 1024)
                            })
                    })
            })
    });
    let network = fs::read_dir("/sys/class/net")?.collect::<Result<Vec<_>, _>>()?;
    let memory = fs::read_to_string("/sys/fs/cgroup/memory.max")?
        .trim()
        .parse::<u64>()
        .ok();
    let pids = fs::read_to_string("/sys/fs/cgroup/pids.max")?
        .trim()
        .parse::<u64>()
        .ok();
    let cpu = fs::read_to_string("/sys/fs/cgroup/cpu.max")?;
    let mut cpu = cpu.split_whitespace();
    let quota = cpu.next().and_then(|v| v.parse::<u64>().ok());
    let period = cpu.next().and_then(|v| v.parse::<u64>().ok());
    if uid.is_none_or(|v| v == 0)
        || value("NoNewPrivs:") != Some("1")
        || value("Seccomp:") != Some("2")
        || value("CapEff:") != Some("0000000000000000")
        || !root_ro
        || !scratch_tmpfs
        || network.iter().any(|entry| entry.file_name() != "lo")
        || memory.is_none_or(|v| v > 512 * 1024 * 1024)
        || pids.is_none_or(|v| v > 64)
        || quota.zip(period).is_none_or(|(q, p)| p == 0 || q > p)
        || std::env::vars_os().any(|(name, _)| {
            !matches!(
                name.to_str(),
                Some(
                    "PATH" | "HOSTNAME" | "HOME" | "HYORI_MEDIA_SOCKET" | "LANG" | "LC_ALL" | "TZ"
                )
            )
        })
    {
        return Err(io::Error::other(
            "media worker isolation requirements are not satisfied",
        ));
    }
    Ok(())
}
