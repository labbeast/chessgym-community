"""Engine stdout stays ordered and bounded, including during shutdown."""
import io
import threading

import pytest

from engine_output import start_reader


def test_reader_preserves_lines_and_reports_eof_without_closing_stream():
    stream = io.StringIO('id name Testfish\r\n\n  info depth 12  \nbestmove e2e4\n')
    messages, stopped, reader = start_reader(stream, name='test-engine-output')
    try:
        assert [messages.get(timeout=2) for _ in range(5)] == [
            'id name Testfish', '', '  info depth 12', 'bestmove e2e4', None]
        reader.join(timeout=2)
        assert not reader.is_alive()
        assert reader.daemon
        assert not stream.closed
    finally:
        stopped.set()
        reader.join(timeout=2)
        stream.close()


@pytest.mark.parametrize('error', [OSError('broken pipe'), ValueError('closed stream')])
def test_reader_reports_pipe_failure_as_eof(error):
    def stream():
        yield 'uciok\n'
        raise error

    messages, stopped, reader = start_reader(stream(), name='test-engine-output')
    try:
        assert messages.get(timeout=2) == 'uciok'
        assert messages.get(timeout=2) is None
        reader.join(timeout=2)
        assert not reader.is_alive()
    finally:
        stopped.set()
        reader.join(timeout=2)


@pytest.mark.parametrize('has_second_line', [False, True])
def test_stop_releases_a_reader_blocked_by_a_full_queue(has_second_line):
    first_line_read = threading.Event()

    def stream():
        yield 'info depth 1\n'
        first_line_read.set()
        if has_second_line:
            yield 'info depth 2\n'

    messages, stopped, reader = start_reader(
        stream(), name='test-engine-output', max_queue_size=1)
    try:
        assert first_line_read.wait(timeout=2)
        assert messages.full()
        stopped.set()
        reader.join(timeout=2)
        assert not reader.is_alive()
        assert messages.get_nowait() == 'info depth 1'
        assert messages.empty()
    finally:
        stopped.set()
        reader.join(timeout=2)
