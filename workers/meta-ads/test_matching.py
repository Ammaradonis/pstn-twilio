import unittest
from datetime import date
from matching import facebook_key, name_key, qualifies


class MatchingTest(unittest.TestCase):
    def test_identity_variants(self):
        self.assertEqual(facebook_key('https://m.facebook.com/School/?ref=ads'), facebook_key('https://www.facebook.com/school'))
        self.assertEqual(facebook_key('https://facebook.com/people/My-School/123456/'), facebook_key('https://facebook.com/profile.php?id=123456'))
        self.assertNotEqual(facebook_key('https://facebook.com/school'), facebook_key('https://facebook.com/123456'))

    def test_reject_non_profiles(self):
        for value in ['', 'https://facebook.com.attacker.test/school', 'https://l.facebook.com/l.php?u=x', 'https://facebook.com/ads/library/?id=123', 'https://facebook.com/groups/school', 'https://facebook.com/profile.php', 'https://facebook.com/school/posts/123']:
            self.assertEqual(facebook_key(value), '', value)

    def test_conservative_names(self):
        self.assertEqual(name_key('School & Academy'), name_key('School and Academy'))
        self.assertNotEqual(name_key('School North'), name_key('School South'))

    def test_overlap_not_start_date_only(self):
        ad = {'status': 'Inactive', 'dateText': 'Aug 27, 2024 - Oct 15, 2026', 'observedAt': '2026-10-22T12:00:00Z'}
        self.assertTrue(qualifies(ad, date(2026, 1, 1), date(2026, 2, 1), False))
        self.assertFalse(qualifies(ad, date(2026, 10, 16), date(2026, 10, 22), False))
        self.assertFalse(qualifies(ad, None, None, False))

    def test_active_and_invalid_dates(self):
        ad = {'status': 'Active', 'dateText': 'Started running on Jan 1, 2026', 'observedAt': '2026-10-22T12:00:00Z'}
        self.assertFalse(qualifies(ad, date(2026, 1, 1), date(2026, 2, 1), False))
        self.assertTrue(qualifies(ad, date(2026, 1, 1), date(2026, 2, 1), True))
        ad['dateText'] = 'Unknown'
        self.assertFalse(qualifies(ad, date(2026, 1, 1), date(2026, 2, 1), True))

    def test_all_time_has_no_age_cutoff(self):
        for status in ['Active', 'Inactive']:
            ad = {'status': status, 'dateText': 'Unknown', 'observedAt': '2026-10-22T12:00:00Z'}
            self.assertTrue(qualifies(ad, None, None, False, all_time=True))
        self.assertFalse(qualifies({'status': 'Unknown'}, None, None, True, all_time=True))

if __name__ == '__main__':
    unittest.main()
