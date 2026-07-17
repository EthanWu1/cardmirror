import importlib
import os
import sys
import tempfile
import unittest
import warnings
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))


class RelaySqliteBootTest(unittest.TestCase):
    def test_sqlite_database_can_store_messages_and_room_updates(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            os.environ["DATABASE_URL"] = f"sqlite:///{Path(tmp) / 'relay.sqlite3'}"
            os.environ["RELAY_TOKEN"] = "test-token"
            sys.modules.pop("relay.server", None)
            server = importlib.import_module("relay.server")
            try:
                with warnings.catch_warnings():
                    warnings.filterwarnings(
                        "ignore",
                        message=r"datetime\.datetime\.utcnow\(\) is deprecated",
                        category=DeprecationWarning,
                    )
                    server.Base.metadata.create_all(server.engine)
                    db = server.SessionLocal()
                    try:
                        db.add(
                            server.RelayMessage(
                                id="msg-1",
                                recipient_code="recipient",
                                body={"recipientCode": "recipient", "ciphertext": "opaque"},
                            )
                        )
                        db.add(server.RelayRoom(id="room-1"))
                        update = server.RelayRoomUpdate(room_id="room-1", blob="encrypted")
                        db.add(update)
                        db.commit()

                        stored = db.get(server.RelayMessage, "msg-1")
                        self.assertEqual(stored.body["ciphertext"], "opaque")
                        self.assertEqual(update.id, 1)
                    finally:
                        db.close()
            finally:
                server.engine.dispose()
                sys.modules.pop("relay.server", None)


if __name__ == "__main__":
    unittest.main()
