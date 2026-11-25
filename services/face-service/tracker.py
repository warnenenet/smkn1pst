from dataclasses import dataclass, field
from typing import Dict, List, Tuple
import math
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

    def assign_tracks(
        self,
        boxes: List[Tuple[float, float, float, float]],
        now: float | None = None,
        ttl_override: float | None = None,
    ) -> List[int]:
        ts = now if now is not None else time.time()
        ttl = max(0.5, float(ttl_override)) if ttl_override is not None else self.ttl_seconds
        expired = [tid for tid, t in self._tracks.items() if ts - t.last_seen > ttl]
        for tid in expired:
            del self._tracks[tid]

        assigned: List[int] = []
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

            if best_tid is None:
                bw = max(1.0, box[2] - box[0])
                bh = max(1.0, box[3] - box[1])
                b_size = max(bw, bh)
                bcx = (box[0] + box[2]) * 0.5
                bcy = (box[1] + box[3]) * 0.5
                best_dist = float("inf")
                for tid, track in self._tracks.items():
                    if tid in used_tracks:
                        continue
                    if ts - track.last_seen > 2.0:
                        continue
                    tw = max(1.0, track.bbox[2] - track.bbox[0])
                    th = max(1.0, track.bbox[3] - track.bbox[1])
                    t_size = max(tw, th)
                    size_ratio = b_size / t_size
                    if size_ratio < 0.55 or size_ratio > 1.85:
                        continue
                    tcx = (track.bbox[0] + track.bbox[2]) * 0.5
                    tcy = (track.bbox[1] + track.bbox[3]) * 0.5
                    dist = math.hypot(bcx - tcx, bcy - tcy)
                    max_dist = max(b_size, t_size) * 1.15
                    if dist <= max_dist and dist < best_dist:
                        best_dist = dist
                        best_tid = tid

            if best_tid is not None:
                used_tracks.add(best_tid)
                tr = self._tracks[best_tid]
                tr.bbox = box
                tr.last_seen = ts
                tr.hits += 1
                assigned.append(best_tid)
            else:
                tid = self._next_id
                self._next_id += 1
                self._tracks[tid] = TrackState(
                    track_id=tid,
                    bbox=box,
                    last_seen=ts,
                    last_dispatched=0.0,
                    hits=1,
                )
                used_tracks.add(tid)
                assigned.append(tid)
        return assigned

    def can_dispatch(self, track_id: int, now: float | None = None) -> bool:
        ts = now if now is not None else time.time()
        tr = self._tracks.get(track_id)
        if tr is None:
            return True
        if tr.last_dispatched <= 0.0:
            return True
        return (ts - tr.last_dispatched) >= self.dispatch_cooldown_sec

    def mark_dispatched(self, track_id: int, now: float | None = None) -> None:
        ts = now if now is not None else time.time()
        tr = self._tracks.get(track_id)
        if tr is not None:
            tr.last_dispatched = ts

    def reset_dispatch_cooldown(self, track_id: int) -> None:
        tr = self._tracks.get(track_id)
        if tr is not None:
            tr.last_dispatched = 0.0


@dataclass
class VoteRecord:
    timestamp: float
    student_id: int
    similarity: float


class TrackVoteBuffer:
    """
    Multi-frame voting buffer per track_id:
    Siswa di-dispatch setelah >= min_votes (default 2) kecocokan ke student_id sama
    dalam vote_window_sec (default 10s) dengan similarity >= vote_threshold (default 0.65).
    """

    def __init__(self) -> None:
        self._buffer: Dict[int, List[VoteRecord]] = {}

    def record_and_evaluate(
        self,
        track_id: int,
        student_id: int | None,
        similarity: float,
        now: float,
        vote_threshold: float = 0.65,
        vote_window_sec: float = 10.0,
        min_votes: int = 2,
    ) -> Tuple[bool, int, str]:
        window = max(1.0, float(vote_window_sec))
        prev = self._buffer.get(track_id, [])
        active = [v for v in prev if (now - v.timestamp) <= window]

        if student_id is None:
            if active:
                self._buffer[track_id] = active
            else:
                self._buffer.pop(track_id, None)
            return False, 0, "anonymous"

        if similarity < vote_threshold:
            if active:
                self._buffer[track_id] = active
            else:
                self._buffer.pop(track_id, None)
            return False, 0, "below_vote_threshold"

        active.append(VoteRecord(timestamp=now, student_id=int(student_id), similarity=float(similarity)))
        same_votes = [v for v in active if v.student_id == int(student_id)]
        if len(same_votes) >= min_votes:
            self._buffer.pop(track_id, None)
            return True, len(same_votes), "confirmed"

        self._buffer[track_id] = active
        return False, len(same_votes), "awaiting_second_vote"

    def clear_expired(self, now: float, vote_window_sec: float = 10.0) -> None:
        window = max(1.0, float(vote_window_sec))
        for tid in list(self._buffer.keys()):
            kept = [v for v in self._buffer[tid] if (now - v.timestamp) <= window]
            if kept:
                self._buffer[tid] = kept
            else:
                del self._buffer[tid]

    def get_votes(self, track_id: int) -> List[VoteRecord]:
        return list(self._buffer.get(track_id, []))
