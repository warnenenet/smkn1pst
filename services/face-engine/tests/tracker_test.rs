use face_engine::tracker::{
    compute_iou, DedupCooldownMap, IoUTracker, LatestFrameSlot, RawFrame,
};

#[test]
fn iou_tracker_assigns_consistent_ids_with_iou_and_centroid_fallback_and_evicts_expired() {
    let mut tracker = IoUTracker::new(0.20, 4000);

    let t0 = tracker.assign_tracks(&[[100.0, 100.0, 200.0, 200.0]], 1000, None);
    assert_eq!(t0.len(), 1);
    let id_a = t0[0];

    // Shifted slightly (high IoU) -> same track id
    let t1 = tracker.assign_tracks(&[[110.0, 108.0, 210.0, 208.0]], 1200, None);
    assert_eq!(t1, vec![id_a]);

    // Fast movement with 0 IoU within 2s and comparable size -> centroid fallback keeps same track id
    let iou = compute_iou([110.0, 108.0, 210.0, 208.0], [215.0, 108.0, 315.0, 208.0]);
    assert_eq!(iou, 0.0);
    let t2 = tracker.assign_tracks(&[[215.0, 108.0, 315.0, 208.0]], 1500, None);
    assert_eq!(t2, vec![id_a]);

    // Expired beyond 4000ms TTL -> gets fresh track id
    let t3 = tracker.assign_tracks(&[[215.0, 108.0, 315.0, 208.0]], 7000, None);
    assert_ne!(t3[0], id_a);
}

#[test]
fn dedup_6s_suppresses_repeats_within_cooldown_and_allows_after() {
    let mut dedup = DedupCooldownMap::new(6);
    assert!(dedup.try_acquire(1, 101, 10_000));
    // Within 6000ms -> suppressed
    assert!(!dedup.try_acquire(1, 101, 12_500));
    assert!(!dedup.try_acquire(1, 101, 15_999));
    // Same student on different camera is independent
    assert!(dedup.try_acquire(2, 101, 12_500));
    // At >= 6000ms elapsed -> allowed again
    assert!(dedup.try_acquire(1, 101, 16_000));

    // Cooldown update from settings works dynamically
    dedup.set_cooldown_sec(10);
    assert!(!dedup.try_acquire(1, 101, 25_000));
    assert!(dedup.try_acquire(1, 101, 26_000));
}

#[test]
fn latest_frame_slot_never_queues_above_one_and_counts_drops() {
    let slot = LatestFrameSlot::new();
    assert!(!slot.has_pending());
    assert_eq!(slot.frames_dropped(), 0);

    for seq in 1..=10u64 {
        slot.push(RawFrame {
            seq,
            captured_ms: seq * 100,
            width: 1920,
            height: 1080,
            rgb: vec![seq as u8; 16],
        });
    }

    assert!(slot.has_pending());
    // 9 earlier frames overwritten, only seq=10 retained
    assert_eq!(slot.frames_dropped(), 9);
    let popped = slot.take_latest().expect("latest frame present");
    assert_eq!(popped.seq, 10);
    assert!(!slot.has_pending());
    assert!(slot.take_latest().is_none());
}
