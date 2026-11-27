use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tokio::sync::Notify;

#[derive(Debug, Clone)]
pub struct RawFrame {
    pub seq: u64,
    pub captured_ms: u64,
    pub width: u32,
    pub height: u32,
    pub rgb: Vec<u8>,
}

/// Single-slot latest-frame handoff between an RTSP decoder task and the inference worker.
/// Never builds a backlog queue: pushing while an older frame is unconsumed overwrites the old frame
/// and increments `frames_dropped`.
pub struct LatestFrameSlot {
    slot: Mutex<Option<RawFrame>>,
    frames_dropped: AtomicU64,
    notify: Notify,
}

impl Default for LatestFrameSlot {
    fn default() -> Self {
        Self::new()
    }
}

impl LatestFrameSlot {
    pub fn new() -> Self {
        Self {
            slot: Mutex::new(None),
            frames_dropped: AtomicU64::new(0),
            notify: Notify::new(),
        }
    }

    pub fn push(&self, frame: RawFrame) {
        let mut guard = self.slot.lock().expect("LatestFrameSlot mutex poisoned");
        let replaced = guard.replace(frame).is_some();
        drop(guard);
        if replaced {
            self.frames_dropped.fetch_add(1, Ordering::Relaxed);
        }
        self.notify.notify_one();
    }

    pub fn take_latest(&self) -> Option<RawFrame> {
        let mut guard = self.slot.lock().expect("LatestFrameSlot mutex poisoned");
        guard.take()
    }

    pub fn has_pending(&self) -> bool {
        self.slot
            .lock()
            .expect("LatestFrameSlot mutex poisoned")
            .is_some()
    }

    pub fn frames_dropped(&self) -> u64 {
        self.frames_dropped.load(Ordering::Relaxed)
    }

    pub async fn notified(&self) {
        self.notify.notified().await;
    }

    pub fn wake(&self) {
        self.notify.notify_one();
    }
}

pub fn compute_iou(a: [f32; 4], b: [f32; 4]) -> f32 {
    let ix1 = a[0].max(b[0]);
    let iy1 = a[1].max(b[1]);
    let ix2 = a[2].min(b[2]);
    let iy2 = a[3].min(b[3]);
    let iw = (ix2 - ix1).max(0.0);
    let ih = (iy2 - iy1).max(0.0);
    let inter = iw * ih;
    if inter <= 0.0 {
        return 0.0;
    }
    let area_a = ((a[2] - a[0]).max(0.0)) * ((a[3] - a[1]).max(0.0));
    let area_b = ((b[2] - b[0]).max(0.0)) * ((b[3] - b[1]).max(0.0));
    let union = area_a + area_b - inter;
    if union > 0.0 { inter / union } else { 0.0 }
}

#[derive(Debug, Clone)]
struct TrackState {
    bbox: [f32; 4],
    last_seen_ms: u64,
    hits: u64,
}

/// Per-camera IoU + centroid fallback face tracker.
#[derive(Debug)]
pub struct IoUTracker {
    iou_threshold: f32,
    ttl_ms: u64,
    next_id: u64,
    tracks: HashMap<u64, TrackState>,
}

impl Default for IoUTracker {
    fn default() -> Self {
        Self::new(0.20, 4_000)
    }
}

impl IoUTracker {
    pub fn new(iou_threshold: f32, ttl_ms: u64) -> Self {
        Self {
            iou_threshold: iou_threshold.clamp(0.05, 0.95),
            ttl_ms: ttl_ms.max(500),
            next_id: 1,
            tracks: HashMap::new(),
        }
    }

    pub fn assign_tracks(
        &mut self,
        boxes: &[[f32; 4]],
        now_ms: u64,
        ttl_override_ms: Option<u64>,
    ) -> Vec<u64> {
        let ttl = ttl_override_ms.map(|v| v.max(500)).unwrap_or(self.ttl_ms);
        self.tracks
            .retain(|_, tr| now_ms.saturating_sub(tr.last_seen_ms) <= ttl);

        let mut assigned = Vec::with_capacity(boxes.len());
        let mut used: HashSet<u64> = HashSet::new();

        for &box_a in boxes {
            let mut best_tid: Option<u64> = None;
            let mut best_iou = self.iou_threshold;

            for (&tid, tr) in &self.tracks {
                if used.contains(&tid) {
                    continue;
                }
                let score = compute_iou(box_a, tr.bbox);
                if score >= best_iou {
                    best_iou = score;
                    best_tid = Some(tid);
                }
            }

            // Centroid fallback for moving heads across frames when IoU drops to 0.
            if best_tid.is_none() {
                let bw = (box_a[2] - box_a[0]).max(1.0);
                let bh = (box_a[3] - box_a[1]).max(1.0);
                let b_size = bw.max(bh);
                let bcx = (box_a[0] + box_a[2]) * 0.5;
                let bcy = (box_a[1] + box_a[3]) * 0.5;
                let mut best_dist = f32::INFINITY;

                for (&tid, tr) in &self.tracks {
                    if used.contains(&tid) {
                        continue;
                    }
                    if now_ms.saturating_sub(tr.last_seen_ms) > 2_000 {
                        continue;
                    }
                    let tw = (tr.bbox[2] - tr.bbox[0]).max(1.0);
                    let th = (tr.bbox[3] - tr.bbox[1]).max(1.0);
                    let t_size = tw.max(th);
                    let size_ratio = b_size / t_size;
                    if !(0.55..=1.85).contains(&size_ratio) {
                        continue;
                    }
                    let tcx = (tr.bbox[0] + tr.bbox[2]) * 0.5;
                    let tcy = (tr.bbox[1] + tr.bbox[3]) * 0.5;
                    let dist = ((bcx - tcx).powi(2) + (bcy - tcy).powi(2)).sqrt();
                    let max_dist = b_size.max(t_size) * 1.15;
                    if dist <= max_dist && dist < best_dist {
                        best_dist = dist;
                        best_tid = Some(tid);
                    }
                }
            }

            if let Some(tid) = best_tid {
                used.insert(tid);
                if let Some(tr) = self.tracks.get_mut(&tid) {
                    tr.bbox = box_a;
                    tr.last_seen_ms = now_ms;
                    tr.hits += 1;
                }
                assigned.push(tid);
            } else {
                let tid = self.next_id;
                self.next_id += 1;
                self.tracks.insert(
                    tid,
                    TrackState {
                        bbox: box_a,
                        last_seen_ms: now_ms,
                        hits: 1,
                    },
                );
                used.insert(tid);
                assigned.push(tid);
            }
        }

        assigned
    }

    pub fn active_tracks(&self) -> usize {
        self.tracks.len()
    }
}

/// Per-(camera_id, student_id) cooldown map preventing burst duplicate attendance dispatches.
#[derive(Debug)]
pub struct DedupCooldownMap {
    cooldown_ms: u64,
    last_dispatched_ms: HashMap<(u64, i64), u64>,
}

impl DedupCooldownMap {
    pub fn new(cooldown_sec: u64) -> Self {
        Self {
            cooldown_ms: cooldown_sec.max(1) * 1000,
            last_dispatched_ms: HashMap::new(),
        }
    }

    pub fn set_cooldown_sec(&mut self, cooldown_sec: u64) {
        self.cooldown_ms = cooldown_sec.max(1) * 1000;
    }

    pub fn try_acquire(&mut self, camera_id: u64, student_id: i64, now_ms: u64) -> bool {
        let key = (camera_id, student_id);
        if let Some(&prev) = self.last_dispatched_ms.get(&key) {
            if now_ms.saturating_sub(prev) < self.cooldown_ms {
                return false;
            }
        }
        self.last_dispatched_ms.insert(key, now_ms);
        if self.last_dispatched_ms.len() > 10_000 {
            let max_keep = self.cooldown_ms.saturating_mul(2);
            self.last_dispatched_ms
                .retain(|_, ts| now_ms.saturating_sub(*ts) <= max_keep);
        }
        true
    }
}
