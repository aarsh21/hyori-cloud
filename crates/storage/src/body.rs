use crate::{Bytes, StorageError, StorageStream};
use http_body::{Body, Frame, SizeHint};
use std::{
    pin::Pin,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    task::{Context, Poll},
};

/// Hold the final frame until EOF: Content-Length alone can hide trailing source bytes.
/// No producer task, channel, eager polling, or file-sized accumulation is introduced.
pub(crate) struct ExactBody {
    // The SDK requires Sync, but a request body is only polled through &mut self.
    // SyncWrapper preserves Send-only source compatibility without locks or unsafe code here.
    source: sync_wrapper::SyncWrapper<StorageStream>,
    remaining: u64,
    final_frame: Option<Bytes>,
    done: bool,
    verified: Arc<AtomicBool>,
}

impl ExactBody {
    pub(crate) fn new(source: StorageStream, length: u64) -> (Self, Arc<AtomicBool>) {
        let verified = Arc::new(AtomicBool::new(false));
        (
            Self {
                source: sync_wrapper::SyncWrapper::new(source),
                remaining: length,
                final_frame: None,
                done: false,
                verified: verified.clone(),
            },
            verified,
        )
    }
}

impl Body for ExactBody {
    type Data = Bytes;
    type Error = StorageError;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, StorageError>>> {
        if self.done {
            return Poll::Ready(None);
        }
        // Yield if an adversarial producer emits only empty frames.
        for _ in 0..16 {
            match self.source.get_mut().as_mut().poll_next(cx) {
                Poll::Pending => return Poll::Pending,
                Poll::Ready(Some(Err(_))) => {
                    self.done = true;
                    return Poll::Ready(Some(Err(StorageError::Body("source failed"))));
                }
                Poll::Ready(Some(Ok(bytes))) => {
                    if bytes.is_empty() {
                        continue;
                    }
                    if bytes.len() as u64 > self.remaining {
                        self.done = true;
                        return Poll::Ready(Some(Err(StorageError::Body(
                            "source exceeds declared length",
                        ))));
                    }
                    self.remaining -= bytes.len() as u64;
                    if self.remaining == 0 {
                        self.final_frame = Some(bytes);
                    } else {
                        return Poll::Ready(Some(Ok(Frame::data(bytes))));
                    }
                }
                Poll::Ready(None) => {
                    self.done = true;
                    if self.remaining != 0 {
                        return Poll::Ready(Some(Err(StorageError::Body(
                            "source shorter than declared length",
                        ))));
                    }
                    self.verified.store(true, Ordering::Release);
                    return Poll::Ready(
                        self.final_frame.take().map(|bytes| Ok(Frame::data(bytes))),
                    );
                }
            }
        }
        cx.waker().wake_by_ref();
        Poll::Pending
    }

    fn is_end_stream(&self) -> bool {
        self.done
    }

    fn size_hint(&self) -> SizeHint {
        SizeHint::with_exact(
            self.remaining + self.final_frame.as_ref().map_or(0, |b| b.len() as u64),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::{StreamExt, future::poll_fn, stream};
    use std::sync::atomic::AtomicUsize;

    async fn next(body: &mut ExactBody) -> Option<Result<Frame<Bytes>, StorageError>> {
        poll_fn(|cx| Pin::new(&mut *body).poll_frame(cx)).await
    }

    #[tokio::test]
    async fn demand_driven_and_exact_even_at_last_frame() {
        let polls = Arc::new(AtomicUsize::new(0));
        let count = polls.clone();
        let input = stream::iter([
            Ok(Bytes::from_static(b"abc")),
            Ok(Bytes::from_static(b"def")),
        ])
        .inspect(move |_| {
            count.fetch_add(1, Ordering::SeqCst);
        });
        let (mut body, verified) = ExactBody::new(Box::pin(input), 6);
        assert_eq!(polls.load(Ordering::SeqCst), 0);
        assert_eq!(
            next(&mut body).await.unwrap().unwrap().into_data().unwrap(),
            "abc"
        );
        assert_eq!(polls.load(Ordering::SeqCst), 1);
        assert!(!verified.load(Ordering::Acquire));
        assert_eq!(
            next(&mut body).await.unwrap().unwrap().into_data().unwrap(),
            "def"
        );
        assert!(verified.load(Ordering::Acquire));
        assert!(next(&mut body).await.is_none());
    }

    #[tokio::test]
    async fn rejects_short_long_and_failed_sources() {
        for (chunks, length) in [
            (vec![Ok(Bytes::from_static(b"a"))], 2),
            (
                vec![Ok(Bytes::from_static(b"a")), Ok(Bytes::from_static(b"b"))],
                1,
            ),
            (vec![Ok(Bytes::from_static(b"ab"))], 1),
            (vec![Err(StorageError::Body("test failure"))], 1),
            (vec![Ok(Bytes::from_static(b"a"))], 0),
        ] {
            let (mut body, verified) = ExactBody::new(Box::pin(stream::iter(chunks)), length);
            let mut failed = false;
            while let Some(frame) = next(&mut body).await {
                failed |= frame.is_err();
            }
            assert!(failed);
            assert!(!verified.load(Ordering::Acquire));
        }
    }

    #[tokio::test]
    async fn final_frame_waits_for_eof_and_drop_cancels_source() {
        struct Source {
            dropped: Arc<AtomicBool>,
            sent: bool,
        }
        impl futures_core::Stream for Source {
            type Item = Result<Bytes, StorageError>;
            fn poll_next(
                mut self: Pin<&mut Self>,
                _: &mut Context<'_>,
            ) -> Poll<Option<Self::Item>> {
                if self.sent {
                    Poll::Pending
                } else {
                    self.sent = true;
                    Poll::Ready(Some(Ok(Bytes::from_static(b"x"))))
                }
            }
        }
        impl Drop for Source {
            fn drop(&mut self) {
                self.dropped.store(true, Ordering::Release);
            }
        }
        let dropped = Arc::new(AtomicBool::new(false));
        let (mut body, verified) = ExactBody::new(
            Box::pin(Source {
                dropped: dropped.clone(),
                sent: false,
            }),
            1,
        );
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(20), next(&mut body))
                .await
                .is_err()
        );
        assert!(!verified.load(Ordering::Acquire));
        drop(body);
        assert!(dropped.load(Ordering::Acquire));
    }
}
