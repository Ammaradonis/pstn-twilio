"""What the profile extractor should and should not believe.

The facts become sentences the school owner reads in the Status column ("Tuesday
is your kids karate night"), so a wrong detail is worse than a missing one: a
programme needs its audience in the same sentence, an instructor needs a
teaching role, and a number that is not a class time never becomes one.
"""
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from email_finder import profile


HOME = ("https://dojo.example/", """
Shotokan Karate in Camden since 1998.

Kids Karate (ages 5-12) is on Tuesdays and Thursdays, 5-6pm.
Adult Karate runs Mondays 7:30-9pm. Beginners welcome in the adult class.

Head instructor Sensei John Smith has taught here for twenty years.
Our gradings are held twice a year and we compete at regional tournaments.

The first class is free. No joining fee.
""")

CLASSES = ("https://dojo.example/classes", """
Little Dragons (ages 4-6) - Saturdays 9-10am.
Junior Karate: Wednesday 5-6pm.
Brazilian Jiu Jitsu for adults: Tuesday 8-9:30pm.

We run a summer camp every August and an open day each spring.
""")

ABOUT = ("https://dojo.example/about", """
Coach Mike Alvarez leads the juniors. Sifu Jane Doe teaches the adult classes.
Our club was founded in 1998 and has produced national champions.
""")


def test_programmes_pair_a_style_with_its_audience_in_one_sentence():
    facts = profile.extract([HOME, CLASSES])
    assert "kids karate" in facts.programs
    assert "judo" not in facts.programs
    # A style named without an audience is still a programme.
    assert "jiu jitsu" in facts.programs


def test_schedule_is_read_as_days_and_times_not_random_numbers():
    facts = profile.extract([HOME])
    assert "Tuesday" in facts.days and "Thursday" in facts.days
    assert "5–6pm" in facts.times
    assert any("Tuesdays" in h for h in facts.hours)
    # "ages 5-12" and "twice a year" are not class times.
    assert not any("5–12" in t for t in facts.times)


def test_a_bare_number_pair_is_never_a_class_time():
    facts = profile.extract([("https://dojo.example/", (
        "Kids karate ages 5-12. Class size 15-20 students. Fees 20-25 per month. "
        "Juniors train Saturdays 9am-11am."))])
    assert facts.times == ["9am–11am"]
    assert all("15" not in t and "20" not in t for t in facts.times)


def test_instructors_keep_the_title_the_school_writes():
    facts = profile.extract([HOME, ABOUT])
    assert any("John Smith" in name for name in facts.instructors)
    assert any(name.startswith("Sensei") for name in facts.instructors), facts.instructors


def test_events_offers_and_age_of_the_school():
    facts = profile.extract([HOME, CLASSES, ABOUT])
    assert "gradings" in facts.events
    assert "competitions" in facts.events
    assert "summer camps" in facts.events
    assert any("free trial" in offer or "first class" in offer for offer in facts.offers)
    assert "no joining fee" in facts.offers
    assert facts.since == "1998"


def test_pages_are_cited_so_the_sentence_can_be_explained():
    facts = profile.extract([HOME, CLASSES])
    assert set(facts.sources) == {HOME[0], CLASSES[0]}


def test_a_page_that_says_nothing_specific_produces_no_facts():
    facts = profile.extract([("https://dojo.example/", "Welcome to our website. Contact us today.")])
    assert facts.facts() is False
    assert facts.to_dict() == {}


def test_the_sheet_category_is_used_when_the_page_never_says_the_style():
    facts = profile.extract([("https://dojo.example/", "Our classes run on Saturdays in the hall.")],
                            category="Karate")
    assert facts.styles == ["karate"]


def test_a_page_that_only_says_martial_arts_still_gives_a_subject():
    """"ATA Martial Arts" never says taekwondo or karate.

    A sentence with a generic subject is honest; a sentence with no subject is
    not a sentence. The generic name is only used when no real style was found,
    so a karate school is never described as "martial arts"."""
    facts = profile.extract([("https://ata.example/", (
        "Welcome to the new ATA Martial Arts school in Denison, Texas. "
        "Benefits of martial arts include mobility, strength and flexibility."))])
    assert facts.styles == ["martial arts"]
    assert facts.programs == ["martial arts"]
    assert facts.facts() is True


def test_a_profile_serialises_to_only_what_it_knows():
    facts = profile.extract([HOME])
    payload = facts.to_dict()
    assert payload["programs"] and payload["days"] and payload["times"]
    assert "instructors" in payload
    for key, value in payload.items():
        if isinstance(value, list):
            assert all(isinstance(item, str) and item.strip() for item in value), key
    assert all(len(item) <= 120 for items in payload.values() if isinstance(items, list)
               for item in items)
