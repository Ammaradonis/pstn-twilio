'use strict';
// Run: node --test workers/maps-refresh/*.test.cjs

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');

const hours = require('./hours.cjs');

describe('formatWeek', () => {
  it('groups consecutive days with the same hours', () => {
    assert.equal(
      hours.formatWeek({
        Monday: '4–9 PM',
        Tuesday: '4–9 PM',
        Wednesday: '4–9 PM',
        Thursday: '4–9 PM',
        Friday: '4–8 PM',
        Saturday: '9 AM–12 PM',
        Sunday: 'closed',
      }),
      'Mon–Thu 4–9 PM; Fri 4–8 PM; Sat 9 AM–12 PM; Sun closed',
    );
  });

  it('counts the days a line covers', () => {
    assert.equal(hours.daysCovered('Mon–Thu 4–9 PM; Fri 4–8 PM; Sat 9 AM–12 PM; Sun closed'), 7);
    assert.equal(hours.daysCovered('Mon–Wed 4–9 PM; Fri 4–9 PM'), 4);
    assert.equal(hours.daysCovered('call us'), 0);
    // Holiday days carry no regular hours.
    assert.equal(
      hours.daysCovered('Mon–Wed 4–9 PM; Thu–Fri holiday; Sat 9 AM–12 PM; Sun closed'),
      5,
    );
  });

  it('formats like the scraper does', () => {
    const scraperFile = path.join(
      process.env.MAPS_SCRAPER_DIR ||
        'C:\\Users\\FingerWeg\\CascadeProjects\\real-google-maps-scraper',
      'extract',
      'openingHours.js',
    );
    if (!fs.existsSync(scraperFile)) return;
    const scraper = require(scraperFile);
    const weeks = [
      { Monday: '4–9 PM', Tuesday: '4–9 PM', Thursday: '4–9 PM', Sunday: 'closed' },
      Object.fromEntries(hours.DAYS.map((day) => [day, 'open 24 hours'])),
      { Saturday: '9 AM–12 PM', Sunday: '9 AM–12 PM' },
    ];
    for (const week of weeks) assert.equal(hours.formatWeek(week), scraper.formatWeek(week));
  });
});

describe('times', () => {
  it('reads 12-hour and 24-hour times', () => {
    assert.equal(hours.minutes('4pm'), 960);
    assert.equal(hours.minutes('4:30 p.m.'), 990);
    assert.equal(hours.minutes('12 PM'), 720);
    assert.equal(hours.minutes('12am'), 0);
    assert.equal(hours.minutes('16:00'), 960);
    assert.equal(hours.minutes('noon'), 720);
    assert.equal(hours.formatRange(960, 1260), '4–9 PM');
    assert.equal(hours.formatRange(540, 720), '9 AM–12 PM');
    assert.equal(hours.formatRange(0, 1440), 'open 24 hours');
  });
});

describe('schemaHours', () => {
  it('reads openingHoursSpecification', () => {
    const html = `<script type="application/ld+json">${JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'SportsActivityLocation',
      openingHoursSpecification: [
        {
          '@type': 'OpeningHoursSpecification',
          dayOfWeek: ['Monday', 'Tuesday', 'Wednesday', 'Thursday'],
          opens: '16:00',
          closes: '21:00',
        },
        { dayOfWeek: 'https://schema.org/Friday', opens: '16:00:00', closes: '20:00:00' },
        { dayOfWeek: 'Saturday', opens: '09:00', closes: '12:00' },
        { dayOfWeek: 'Sunday', opens: '00:00', closes: '00:00' },
        // A typo on the site (closes before it opens) is left out, not written.
        { dayOfWeek: 'Saturday', opens: '22:00', closes: '21:00' },
        // A holiday exception is not the regular week.
        {
          dayOfWeek: 'Monday',
          opens: '00:00',
          closes: '00:00',
          validFrom: '2026-12-25',
          validThrough: '2026-12-25',
        },
      ],
    })}</script>`;
    assert.equal(
      hours.formatWeek(hours.schemaHours(html)),
      'Mon–Thu 4–9 PM; Fri 4–8 PM; Sat 9 AM–12 PM; Sun closed',
    );
  });

  it('reads openingHours strings in JSON-LD and microdata', () => {
    const jsonld = `<script type="application/ld+json">{"@graph":[{"@type":"LocalBusiness","openingHours":["Mo-Fr 16:00-21:00","Sa 09:00-12:00"]}]}</script>`;
    assert.equal(hours.formatWeek(hours.schemaHours(jsonld)), 'Mon–Fri 4–9 PM; Sat 9 AM–12 PM');
    const micro = '<meta itemprop="openingHours" content="Mo,We,Fr 17:00-20:30">';
    assert.equal(
      hours.formatWeek(hours.schemaHours(micro)),
      'Mon 5–8:30 PM; Wed 5–8:30 PM; Fri 5–8:30 PM',
    );
  });
});

describe('textHours', () => {
  it('reads an Hours block, one day group per line', () => {
    const html = `
      <footer><h4>Hours</h4>
        <p>Monday - Thursday: 4:00pm - 9:00pm</p>
        <p>Friday: 4pm-8pm</p>
        <p>Saturday: 9-12pm</p>
        <p>Sunday: Closed</p>
      </footer>`;
    assert.equal(
      hours.formatWeek(hours.textHours(html)),
      'Mon–Thu 4–9 PM; Fri 4–8 PM; Sat 9 AM–12 PM; Sun closed',
    );
  });

  it('reads hours written on the heading line', () => {
    const html = '<div>Hours of Operation: Mon-Fri 4pm - 9pm | Sat 10am - 1pm | Sun closed</div>';
    assert.equal(
      hours.formatWeek(hours.textHours(html)),
      'Mon–Fri 4–9 PM; Sat 10 AM–1 PM; Sun closed',
    );
  });

  it('reads a day line followed by its times', () => {
    const html = '<h3>Office Hours</h3><span>Monday – Friday</span><span>3:30 PM – 8:30 PM</span>';
    assert.equal(hours.formatWeek(hours.textHours(html)), 'Mon–Fri 3:30–8:30 PM');
  });

  it('does not guess am or pm', () => {
    const html = '<h4>Hours</h4><p>Mon-Fri 5:30-6:30</p><p>Sat 9-12</p>';
    assert.deepEqual(hours.textHours(html), {});
  });

  it('does not read a class schedule as opening hours', () => {
    const html = `<h2>Class hours</h2>
      <p>Monday 5pm - 6pm Kids</p><p>Monday 6pm - 7pm Adults</p><p>Tuesday 5pm - 6pm Kids</p>
      <p>Wednesday 5pm - 6pm Kids</p>`;
    assert.deepEqual(hours.textHours(html), {});
  });

  it('needs an Hours heading', () => {
    const html = '<p>Monday - Friday: 4pm - 9pm</p><p>Saturday: 9am - 12pm</p>';
    assert.deepEqual(hours.textHours(html), {});
  });
});

describe('websiteHours', () => {
  const page = (body, type = 'text/html; charset=utf-8') => ({
    ok: true,
    url: '',
    headers: { get: () => type },
    text: async () => body,
  });

  it('reads the homepage, then a contact page it links to', async () => {
    const seen = [];
    const fetchImpl = async (url) => {
      seen.push(url);
      if (url === 'https://dojo.example/') {
        return { ...page('<a href="/contact-us">Contact</a><a href="/blog">Blog</a>'), url };
      }
      if (url === 'https://dojo.example/contact-us') {
        return { ...page('<h4>Hours</h4><p>Mon-Fri 4pm-9pm</p><p>Sat 9am-12pm</p>'), url };
      }
      return { ok: false, headers: { get: () => '' } };
    };
    const result = await hours.websiteHours('https://dojo.example/', { fetchImpl });
    assert.equal(result.hours, 'Mon–Fri 4–9 PM; Sat 9 AM–12 PM');
    assert.match(result.source, /^text:https:\/\/dojo\.example\/contact-us$/);
    assert.deepEqual(seen, ['https://dojo.example/', 'https://dojo.example/contact-us']);
  });

  it('never fetches social pages or private addresses', async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return page('');
    };
    for (const url of [
      'https://www.facebook.com/somedojo',
      'https://instagram.com/somedojo',
      'http://192.168.1.10/',
      'http://localhost:3000/',
      'not a url',
    ]) {
      assert.equal((await hours.websiteHours(url, { fetchImpl })).hours, '');
    }
    assert.equal(calls, 0);
  });

  it('runs at most N at a time', async () => {
    let running = 0;
    let peak = 0;
    const out = await hours.mapLimit([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
      return n * 2;
    });
    assert.deepEqual(out, [2, 4, 6, 8, 10, 12, 14]);
    assert.equal(peak, 3);
  });
});
