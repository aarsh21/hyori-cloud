use std::{fmt, io::IsTerminal};
use tracing::{
    Event, Subscriber,
    field::{Field, Visit},
};
use tracing_subscriber::{
    EnvFilter,
    fmt::{
        FmtContext, FormatEvent, FormatFields,
        format::{Writer, format},
    },
    registry::LookupSpan,
};

pub(super) fn init(production: bool) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| "hyori_server=info".into());
    let subscriber = tracing_subscriber::fmt().with_env_filter(filter);
    if production {
        subscriber
            .json()
            .with_current_span(false)
            .with_span_list(false)
            .with_ansi(false)
            .try_init()
    } else {
        let color = std::io::stdout().is_terminal()
            && std::env::var_os("NO_COLOR").is_none_or(|value| value.is_empty());
        subscriber
            .with_ansi(color)
            .event_format(Development)
            .try_init()
    }
}

struct Development;

impl<S, N> FormatEvent<S, N> for Development
where
    S: Subscriber + for<'a> LookupSpan<'a>,
    N: for<'a> FormatFields<'a> + 'static,
{
    fn format_event(
        &self,
        ctx: &FmtContext<'_, S, N>,
        mut writer: Writer<'_>,
        event: &Event<'_>,
    ) -> fmt::Result {
        if event.metadata().target() != "hyori_server::request" {
            return format().compact().format_event(ctx, writer, event);
        }

        // The development view renders the same canonical event, not a second log at the call site.
        let mut line = RequestLine::default();
        event.record(&mut line);
        let tone = match (writer.has_ansi_escapes(), line.outcome.as_str()) {
            (true, "success") => "\x1b[32m",
            (true, "client_error") => "\x1b[33m",
            (true, "server_error") => "\x1b[31m",
            (true, "cancelled") => "\x1b[2m",
            _ => "",
        };
        let reset = if tone.is_empty() { "" } else { "\x1b[0m" };

        write!(writer, "{} {} {tone}", line.method, line.operation)?;
        match line.status {
            Some(status) => write!(writer, "{status}")?,
            None => writer.write_char('-')?,
        }
        write!(
            writer,
            " {}{reset} {:.0}ms",
            line.outcome,
            line.duration_seconds * 1_000.0
        )?;
        if !line.error_code.is_empty() && line.error_code != "none" {
            write!(writer, " error={}", line.error_code)?;
        }
        writeln!(writer, " request_id={}", line.request_id)
    }
}

#[derive(Default)]
struct RequestLine {
    method: String,
    operation: String,
    status: Option<u64>,
    outcome: String,
    duration_seconds: f64,
    error_code: String,
    request_id: String,
}

impl Visit for RequestLine {
    fn record_str(&mut self, field: &Field, value: &str) {
        let slot = match field.name() {
            "method" => &mut self.method,
            "operation" => &mut self.operation,
            "outcome" => &mut self.outcome,
            "error_code" => &mut self.error_code,
            "request_id" => &mut self.request_id,
            _ => return,
        };
        value.clone_into(slot);
    }

    fn record_u64(&mut self, field: &Field, value: u64) {
        if field.name() == "status" {
            self.status = Some(value);
        }
    }

    fn record_f64(&mut self, field: &Field, value: f64) {
        if field.name() == "duration_seconds" {
            self.duration_seconds = value;
        }
    }

    fn record_debug(&mut self, _: &Field, _: &dyn fmt::Debug) {}
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io,
        sync::{Arc, Mutex},
    };

    #[derive(Clone, Default)]
    struct Capture(Arc<Mutex<Vec<u8>>>);

    impl io::Write for Capture {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            self.0.lock().unwrap().write(bytes)
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn development_summaries_show_optional_status_and_error_without_extra_fields() {
        let output = Capture::default();
        let writer = output.clone();
        let subscriber = tracing_subscriber::fmt()
            .with_ansi(false)
            .event_format(Development)
            .with_writer(move || writer.clone())
            .finish();
        tracing::subscriber::with_default(subscriber, || {
            tracing::info!(target: "hyori_server::request", method = "POST", operation = "files.list",
                status = Some(401_u16), outcome = "client_error", duration_seconds = 0.0074,
                error_code = "auth.required", request_id = "first");
            tracing::info!(target: "hyori_server::request", method = "PUT", operation = "storage.upload",
                status = None::<u16>, outcome = "cancelled", duration_seconds = 0.1548,
                error_code = "none", request_id = "second", transfer_kind = "new_file");
        });
        assert_eq!(
            std::str::from_utf8(&output.0.lock().unwrap()).unwrap(),
            concat!(
                "POST files.list 401 client_error 7ms error=auth.required request_id=first\n",
                "PUT storage.upload - cancelled 155ms request_id=second\n"
            )
        );
    }
}
