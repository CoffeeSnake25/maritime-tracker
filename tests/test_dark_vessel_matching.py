import unittest

from dark_vessel_matching import (
    MATCH_DISTANCE_KM,
    MATCH_TIME_WINDOW_MINUTES,
    anomaly_candidates,
    detection_result,
    haversine_km,
    parse_iso_datetime,
)


class DarkVesselMatchingTest(unittest.TestCase):
    def setUp(self):
        self.vessel = {
            "mmsi": "123456789",
            "ship_name": "TEST AIS",
            "lat": 26.0,
            "lon": 56.0,
            "last_seen": "2026-04-21T13:00:00Z",
            "source": "mock",
        }

    def detection(self, **overrides):
        record = {
            "detection_id": "SAT-TEST",
            "lat": 26.001,
            "lon": 56.001,
            "detected_at": "2026-04-21T13:10:00Z",
            "source": "mock_satellite",
        }
        record.update(overrides)
        return record

    def test_parse_iso_datetime_supports_z_suffix(self):
        parsed = parse_iso_datetime("2026-04-21T13:00:00Z")
        self.assertEqual(parsed.isoformat(), "2026-04-21T13:00:00+00:00")

    def test_haversine_returns_distance_in_km(self):
        distance = haversine_km(26.0, 56.0, 26.01, 56.0)
        self.assertGreater(distance, 1.0)
        self.assertLess(distance, MATCH_DISTANCE_KM)

    def test_detection_matches_when_distance_and_time_pass(self):
        result = detection_result(self.detection(), [self.vessel])
        self.assertFalse(result["is_anomaly_candidate"])
        self.assertEqual(result["matched_vessel"]["mmsi"], "123456789")
        self.assertTrue(result["passes_distance"])
        self.assertTrue(result["passes_time"])

    def test_spatial_miss_is_anomaly(self):
        result = detection_result(self.detection(lat=26.1, lon=56.1), [self.vessel])
        self.assertTrue(result["is_anomaly_candidate"])
        self.assertFalse(result["passes_distance"])
        self.assertTrue(result["passes_time"])

    def test_time_window_miss_is_anomaly(self):
        result = detection_result(
            self.detection(detected_at="2026-04-21T13:31:01Z"),
            [self.vessel],
        )
        self.assertTrue(result["is_anomaly_candidate"])
        self.assertTrue(result["passes_distance"])
        self.assertFalse(result["passes_time"])
        self.assertGreater(result["time_delta_minutes"], MATCH_TIME_WINDOW_MINUTES)

    def test_anomaly_candidates_filters_only_unmatched_detections(self):
        detections = [
            self.detection(detection_id="SAT-MATCH"),
            self.detection(detection_id="SAT-SPATIAL", lat=27.0, lon=57.0),
            self.detection(detection_id="SAT-TIME", detected_at="2026-04-21T14:00:00Z"),
        ]
        anomalies = anomaly_candidates(detections, [self.vessel])
        self.assertEqual([item["detection"]["detection_id"] for item in anomalies], ["SAT-SPATIAL", "SAT-TIME"])

    def test_invalid_values_do_not_crash_matching(self):
        result = detection_result(
            self.detection(lat=None, lon=None, detected_at="not-a-date"),
            [self.vessel],
        )
        self.assertTrue(result["is_anomaly_candidate"])
        self.assertIsNone(result["distance_km"])
        self.assertIsNone(result["time_delta_minutes"])


if __name__ == "__main__":
    unittest.main()
