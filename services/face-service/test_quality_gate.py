import unittest

from quality_gate import (
    compute_ort_thread_budget,
    estimate_pose_deg_from_5pts,
    evaluate_pre_embedding_gates,
    evaluate_top1_top2_margin,
    resolve_adaptive_recognition_threshold,
    validate_five_landmarks,
)
from tracker import IoUTracker, TrackVoteBuffer

VALID_BBOX = (100.0, 100.0, 220.0, 240.0)
VALID_KPS = (
    (138.0, 152.0),  # left_eye
    (182.0, 152.0),  # right_eye
    (160.0, 178.0),  # nose
    (142.0, 204.0),  # mouth_left
    (178.0, 204.0),  # mouth_right
)
DEFAULT_CFG = {
    "threshold_confidence": 0.60,
    "min_face_size": 60,
    "blur_threshold": 100,
    "max_yaw_deg": 30,
    "max_pitch_deg": 25,
}


class QualityGateTests(unittest.TestCase):
    def test_valid_five_landmarks(self):
        ok, reason = validate_five_landmarks(VALID_BBOX, VALID_KPS)
        self.assertTrue(ok)
        self.assertEqual(reason, "ok")

    def test_swapped_eyes_rejected(self):
        bad = ((185.0, 152.0), (135.0, 152.0), VALID_KPS[2], VALID_KPS[3], VALID_KPS[4])
        ok, reason = validate_five_landmarks(VALID_BBOX, bad)
        self.assertFalse(ok)
        self.assertEqual(reason, "swapped_eyes")

    def test_nose_outside_bbox_rejected(self):
        bad = (VALID_KPS[0], VALID_KPS[1], (250.0, 178.0), VALID_KPS[3], VALID_KPS[4])
        ok, reason = validate_five_landmarks(VALID_BBOX, bad)
        self.assertFalse(ok)
        self.assertEqual(reason, "landmark_outside_bbox")

    def test_mouth_above_eyes_rejected(self):
        bad = (VALID_KPS[0], VALID_KPS[1], VALID_KPS[2], (142.0, 140.0), (178.0, 140.0))
        ok, reason = validate_five_landmarks(VALID_BBOX, bad)
        self.assertFalse(ok)
        self.assertEqual(reason, "nose_not_between_eyes_and_mouth")

    def test_eyes_too_close_rejected(self):
        bad = ((156.0, 152.0), (164.0, 152.0), VALID_KPS[2], VALID_KPS[3], VALID_KPS[4])
        ok, reason = validate_five_landmarks(VALID_BBOX, bad)
        self.assertFalse(ok)
        self.assertEqual(reason, "eyes_too_close")

    def test_fewer_than_five_landmarks_rejected(self):
        ok, reason = validate_five_landmarks(VALID_BBOX, VALID_KPS[:4])
        self.assertFalse(ok)
        self.assertEqual(reason, "incomplete_landmarks")

    def test_pipeline_short_circuits_before_blur_and_rejects_blur_and_pose(self):
        calls = {"blur": 0}

        def blur_fn():
            calls["blur"] += 1
            return 45.0

        r_conf = evaluate_pre_embedding_gates(0.45, VALID_BBOX, VALID_KPS, 60, blur_fn, DEFAULT_CFG)
        self.assertFalse(r_conf.passed)
        self.assertEqual(r_conf.reason, "confidence")
        self.assertEqual(calls["blur"], 0)

        r_blur = evaluate_pre_embedding_gates(0.90, VALID_BBOX, VALID_KPS, 60, blur_fn, DEFAULT_CFG)
        self.assertFalse(r_blur.passed)
        self.assertEqual(r_blur.reason, "blur")
        self.assertEqual(calls["blur"], 1)

        yaw_kps = ((135.0, 152.0), (185.0, 152.0), (182.0, 178.0), (145.0, 204.0), (180.0, 204.0))
        yaw, _, _ = estimate_pose_deg_from_5pts(yaw_kps)
        self.assertGreater(abs(yaw), 30.0)
        r_pose = evaluate_pre_embedding_gates(0.90, VALID_BBOX, yaw_kps, 60, lambda: 300.0, DEFAULT_CFG)
        self.assertFalse(r_pose.passed)
        self.assertEqual(r_pose.reason, "pose")

    def test_margin_check(self):
        bid, sim, sec, margin, reason = evaluate_top1_top2_margin([(1, 0.85), (2, 0.72)], 0.70, 0.08)
        self.assertEqual(bid, 1)
        self.assertIsNone(reason)
        self.assertAlmostEqual(margin, 0.13, places=3)

        bid2, _, _, margin2, reason2 = evaluate_top1_top2_margin([(1, 0.82), (2, 0.78)], 0.70, 0.08)
        self.assertIsNone(bid2)
        self.assertEqual(reason2, "ambiguous_margin")
        self.assertAlmostEqual(margin2, 0.04, places=3)

        bid3, _, _, _, reason3 = evaluate_top1_top2_margin([(1, 0.62), (2, 0.40)], 0.70, 0.08)
        self.assertIsNone(bid3)
        self.assertEqual(reason3, "below_threshold")

        bid4, _, _, margin4, reason4 = evaluate_top1_top2_margin([(1, 0.85), (2, 0.85)], 0.70, 0.08)
        self.assertIsNone(bid4)
        self.assertEqual(reason4, "ambiguous_margin")
        self.assertAlmostEqual(margin4, 0.0, places=4)

    def test_multiframe_voting(self):
        tracker = IoUTracker()
        voter = TrackVoteBuffer()
        tid = tracker.assign_tracks([VALID_BBOX], 100.0)[0]

        ok1, cnt1, r1 = voter.record_and_evaluate(tid, 10, 0.72, 100.0, 0.65, 10.0)
        self.assertFalse(ok1)
        self.assertEqual(cnt1, 1)
        self.assertEqual(r1, "awaiting_second_vote")

        ok_diff, cnt_diff, _ = voter.record_and_evaluate(tid, 11, 0.75, 101.0, 0.65, 10.0)
        self.assertFalse(ok_diff)
        self.assertEqual(cnt_diff, 1)

        ok2, cnt2, r2 = voter.record_and_evaluate(tid, 10, 0.74, 102.0, 0.65, 10.0)
        self.assertTrue(ok2)
        self.assertEqual(cnt2, 2)
        self.assertEqual(r2, "confirmed")

    def test_adaptive_threshold_and_8vcpu_budget(self):
        cfg = {
            "threshold_recognition": 0.70,
            "adaptive_threshold_enabled": True,
            "threshold_high_quality": 0.60,
            "threshold_mid_quality": 0.75,
        }
        self.assertEqual(resolve_adaptive_recognition_threshold(0.88, cfg), (True, 0.60, "high_quality"))
        self.assertEqual(resolve_adaptive_recognition_threshold(0.75, cfg), (True, 0.75, "mid_quality"))
        self.assertEqual(resolve_adaptive_recognition_threshold(0.62, cfg), (False, 1.0, "low_quality"))

        workers, intra, inter = compute_ort_thread_budget(8)
        self.assertEqual(workers, 2)
        self.assertEqual(intra, 3)
        self.assertEqual(inter, 1)
        self.assertLessEqual(workers * intra, 6)

    def test_overhead_cctv_landmarks_and_walking_tracker(self):
        overhead_kps = (
            (138.0, 148.0),
            (182.0, 148.0),
            (160.0, 181.0),  # ratio=1.65
            (142.0, 201.0),
            (178.0, 201.0),
        )
        ok, reason = validate_five_landmarks(VALID_BBOX, overhead_kps)
        self.assertTrue(ok, reason)

        tracker = IoUTracker(iou_threshold=0.20, ttl_seconds=4.0)
        t1 = tracker.assign_tracks([(100.0, 100.0, 170.0, 180.0)], now=10.0)[0]
        t2 = tracker.assign_tracks([(155.0, 105.0, 225.0, 185.0)], now=10.35)[0]
        self.assertEqual(t1, t2)

    def test_max_face_size_range_and_masked_landmarks(self):
        big_bbox = (100.0, 100.0, 420.0, 460.0)  # min side = 320px
        big_kps = (
            (195.0, 230.0),
            (325.0, 230.0),
            (260.0, 295.0),
            (205.0, 360.0),
            (315.0, 360.0),
        )
        calls = {"blur": 0}

        def blur_fn():
            calls["blur"] += 1
            return 220.0

        # Oversized face rejected before blur check
        res_over = evaluate_pre_embedding_gates(
            0.91, big_bbox, big_kps, 60, blur_fn, DEFAULT_CFG, max_face_size_px=260
        )
        self.assertFalse(res_over.passed)
        self.assertEqual(res_over.reason, "size")
        self.assertEqual(res_over.detail, "px=320>260")
        self.assertEqual(calls["blur"], 0)

        # Clamps eff_max_size >= eff_min_size (min=120, raw max=90 -> eff_max=120, bbox min=120 passes)
        res_clamp = evaluate_pre_embedding_gates(
            0.91, VALID_BBOX, VALID_KPS, 120, blur_fn, DEFAULT_CFG, max_face_size_px=90
        )
        self.assertTrue(res_clamp.passed)
        self.assertEqual(calls["blur"], 1)

        # Masked face missing mouth landmarks rejected at Step 3 before blur check
        masked_kps = (VALID_KPS[0], VALID_KPS[1], VALID_KPS[2])
        res_masked = evaluate_pre_embedding_gates(
            0.91, VALID_BBOX, masked_kps, 60, blur_fn, DEFAULT_CFG, max_face_size_px=0
        )
        self.assertFalse(res_masked.passed)
        self.assertEqual(res_masked.reason, "landmark")
        self.assertEqual(res_masked.detail, "incomplete_landmarks")
        self.assertEqual(calls["blur"], 1)


if __name__ == "__main__":
    unittest.main()
