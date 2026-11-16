from dataclasses import dataclass, field
from typing import Dict, List, Tuple
import time


def compute_iou(box_a: Tuple[float, float, float, float], box_b: Tuple[float, float, float, float]) -> float:
    ax1, ay1, ax2, ay2 = box_a
    bx1, by1, bx2, by2 = box_b
    ix1 = max(ax1, bx1)
    iy1 = max(ay1, by1)
    ix2 = min(ax2, bx2)
    iy2 = min(ay2, by2)
    iw = max(0.0, ix2 - ix1)
    ih = max(0.0, iy2 - iy1)
    inter = iw * ih
    if inter <= 0.0:
        return 0.0
    area_a = max(0.0, (ax2 - ax1) * (ay2 - ay1))
    area_b = max(0.0, (bx2 - bx1) * (by2 - by1))
    union = area_a + area_b - inter
    return inter / union if union > 0.0 else 0.0


@dataclass
class TrackState:
    track_id: int
    bbox: Tuple[float, float, float, float]
    last_seen: float
    last_dispatched: float = 0.0
    hits: int = 1


class IoUTracker:
    """Lightweight IoU tracker for 5-FPS RTSP gate streams."""

    def __init__(self, iou_threshold: float = 0.35, ttl_seconds: float = 4.0, dispatch_cooldown_sec: float = 12.0):
        self.iou_threshold = iou_threshold
        self.ttl_seconds = ttl_seconds
        self.dispatch_cooldown_sec = dispatch_cooldown_sec
        self._next_id = 1
        self._tracks: Dict[int, TrackState] = {}

    def update(self, boxes: List[Tuple[float, float, float, float]], now: float | None = None) -> List[Tuple[int, bool]]:
        ts = now if now is not None else time.time()
        expired = [tid for tid, t in self._tracks.items() if ts - t.last_seen > self.ttl_seconds]
        for tid in expired:
            del self._tracks[tid]

        results: List[Tuple[int, bool]] = []
        used_tracks = set()

        for box in boxes:
            best_tid = None
            best_iou = self.iou_threshold
            for tid, track in self._tracks.items():
                if tid in used_tracks:
                    continue
                score = compute_iou(box, track.bbox)
                if score >= best_iou:
                    best_iou = score
                    best_tid = tid

            if best_tid is not None:
                used_tracks.add(best_tid)
                tr = self._tracks[best_tid]
                tr.bbox = box
                tr.last_seen = ts
                tr.hits += 1
                should_dispatch = (ts - tr.last_dispatched) >= self.dispatch_cooldown_sec
                if should_dispatch:
                    tr.last_dispatched = ts
                results.append((best_tid, should_dispatch))
            else:
                tid = self._next_id
                self._next_id += 1
                self._tracks[tid] = TrackState(
                    track_id=tid,
                    bbox=box,
                    last_seen=ts,
                    last_dispatched=ts,
                    hits=1,
                )
                used_tracks.add(tid)
                results.append((tid, True))

        return results
