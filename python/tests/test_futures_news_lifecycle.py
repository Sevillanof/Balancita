import unittest

from balancita_engine import futures_qwen_noticias as news


class NewsLifecycleTests(unittest.TestCase):
    def test_lifecycle_uses_the_actual_signal_policy_and_durable_consumption(self):
        feed = news.NewsFeed.__new__(news.NewsFeed)
        feed.available, feed.last_error, feed.priority_policy = True, None, {}
        feed.priority_events = [{
            "item_hash": "one", "event_id": "event-one", "side": -1,
            "published_at": 1000, "known_at": 2000, "expires_at": 1000 + news.PRIORITY_MAX_AGE_MS,
        }]
        feed.priority_rejections = [{"item_hash": "other", "known_at": 1500, "reason": "not_strong_directional_news"}]
        view = feed.lifecycle_at(3000)
        self.assertEqual(view["items"]["one"]["status"], "eligible")
        self.assertEqual(view["items"]["other"]["reason"], "not_strong_directional_news")
        self.assertEqual(feed.lifecycle_at(3000, consumed_event_ids={"event-one"})["items"]["one"]["status"], "used")
        self.assertEqual(feed.lifecycle_at(1000 + news.PRIORITY_MAX_AGE_MS)["items"]["one"]["status"], "expired")
        feed.priority_events.append(dict(feed.priority_events[0], item_hash="two", event_id="event-two", side=1))
        self.assertTrue(all(item["status"] == "conflict" for key, item in feed.lifecycle_at(3000)["items"].items() if key != "other"))


if __name__ == "__main__":
    unittest.main()
