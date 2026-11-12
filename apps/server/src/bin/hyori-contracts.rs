use std::io::Write;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let manifest = hyori_server::wire::manifest()?;
    let mut stdout = std::io::stdout().lock();
    serde_json::to_writer_pretty(&mut stdout, &manifest)?;
    writeln!(stdout)?;
    Ok(())
}
