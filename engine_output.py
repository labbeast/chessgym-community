"""Bounded stdout readers shared by the independent local engine processes."""
import queue
import threading


def start_reader(stream, *, name, max_queue_size=2048):
    """Return the message queue, stop event and running daemon reader.

    EOF (including a broken/closed pipe) is represented by ``None``. The owner
    sets the stop event before closing the process, so a full queue cannot keep
    its reader alive during cleanup. Process and stream ownership stay with the
    caller; stopping the queue alone cannot interrupt a blocked stream read.
    """
    messages = queue.Queue(maxsize=max_queue_size)
    stopped = threading.Event()

    def put(value):
        while not stopped.is_set():
            try:
                messages.put(value, timeout=.1)
                return
            except queue.Full:
                pass

    def output():
        try:
            for line in stream:
                if stopped.is_set():
                    break
                put(line.rstrip())
        except (OSError, ValueError):
            pass
        finally:
            put(None)

    reader = threading.Thread(target=output, name=name, daemon=True)
    reader.start()
    return messages, stopped, reader
