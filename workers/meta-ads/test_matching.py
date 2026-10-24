import unittest
from datetime import date
from matching import facebook_key, has_own_page, is_evidence, match_kind, name_key, qualifies


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


class EvidenceTest(unittest.TestCase):
    """What may be uploaded for the Dial page's filter, and what may be blue.

    On 23 Oct only 2 of 209 name-matched candidates were uploaded: 188 tabs hold
    no facebookUrl, so the page identity could never match and the filter looked
    dead. The name identity is now evidence - but never a blue background."""

    def test_the_page_identity_is_evidence(self):
        self.assertTrue(is_evidence(name_match=True, url_match=True, own_page=True, eligible=True))
        self.assertTrue(is_evidence(name_match=False, url_match=True, own_page=True, eligible=True))
        self.assertEqual(match_kind(True), 'page')

    def test_an_exact_name_without_a_page_is_evidence(self):
        self.assertTrue(is_evidence(name_match=True, url_match=False, own_page=False, eligible=True))
        self.assertEqual(match_kind(False), 'name')

    def test_a_name_that_does_not_match_is_not_evidence(self):
        self.assertFalse(is_evidence(name_match=False, url_match=False, own_page=False, eligible=True))

    def test_a_row_with_a_page_that_is_not_the_ads_page_is_not_evidence(self):
        self.assertFalse(is_evidence(name_match=True, url_match=False, own_page=True, eligible=True))

    def test_dates_outside_the_policy_are_not_evidence(self):
        self.assertFalse(is_evidence(name_match=True, url_match=False, own_page=False, eligible=False))
        self.assertFalse(is_evidence(name_match=True, url_match=True, own_page=True, eligible=False))

    def test_a_blank_cell_is_not_a_page(self):
        self.assertFalse(has_own_page(''))
        self.assertFalse(has_own_page('   '))
        self.assertTrue(has_own_page('https://www.facebook.com/dallaskarate'))


if __name__ == '__main__':
    unittest.main()
