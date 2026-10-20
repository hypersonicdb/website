import { useEffect, useRef, useState } from 'react';

const CHARS_PER_SECOND = 520;
const CARET_LEAD_MS = 800; // the caret blinks alone for a moment before the first character is written

// segs: [text, bold] pairs. Markers never reach the screen, so a half-typed line can't show stray asterisks.
const P = (...segs) => ({ kind: 'p', segs });
const EXAMPLE = (title, code) => [
  { kind: 'title', segs: [[title, true]] },
  { kind: 'code', text: code },
];

const BLOCKS = [
  P([
    'The first time-based database that supports time travel and entity merging, operates without a fixed schema, and evolves its own ontology over time. It uses a hypergraph to model relationships between entities.',
    false,
  ]),
  P(['This is what modern AI is missing.', true]),
  { kind: 'h3', segs: [['Examples', true]] },
  ...EXAMPLE(
    '1. Remember entity properties and observations over time.',
    `UPSERT ENTITIES [
    person(@id="john", name="John"),
    person(@id="john", email="john.connor@gmail.com", purchase=360),
    person(@id="sarah", email="sarah.connor@gmail.com") TEXT "Blond lady"
]`,
  ),
  ...EXAMPLE(
    '2. Update an entity while preserving its history.',
    `UPSERT ENTITIES [
    person(@id="john", name="Johnny", @ts="2026-03-23")
]`,
  ),
  ...EXAMPLE(
    '3. Recall everything remembered about John Connor, including the history of recorded facts.',
    `SELECT *
FROM ENTITY person
WHERE name = "John" AND surname = "Connor"
HISTORY;`,
  ),
  ...EXAMPLE(
    '4. Travel back in time to find out whether someone was known as Johnny on July 12, 2025.',
    `SELECT *
FROM ENTITY person AS OF "2025-07-12"
WHERE name = "Johnny" AND surname = "Connor";`,
  ),
  ...EXAMPLE(
    '5. Define a new identity resolution strategy based on email addresses.',
    'ADD IDENTITY by-email ON person USING email;',
  ),
  ...EXAMPLE(
    "6. Retrieve each person's purchases, resolving identities by email.",
    `SELECT name, surname, purchase
FROM ENTITY person USING IDENTITY by-email;`,
  ),
  ...EXAMPLE(
    "7. Define a new property that aggregates each person's purchases.",
    `ADD RULES FOR ENTITY person (
    $purchased DECIMAL FROM purchase { MERGE: SUM }
);`,
  ),
  ...EXAMPLE(
    '8. Reconstruct historical knowledge, resolve identities by email, and calculate how much each person has purchased.',
    `SELECT name, surname, $purchased
FROM ENTITY person USING IDENTITY by-email;`,
  ),
  ...EXAMPLE(
    '9. Record events as factual observations and connect them to participating entities.',
    `INSERT EVENTS [
    born(
        @ts="February 28, 1985",
        @uri="file://john_connor.md"
    )
    PARTICIPANTS [person:"john", person:"sarah"]
    TEXT "John Connor was born"
]`,
  ),
  ...EXAMPLE(
    '10. Recall events using entity identities and other criteria.',
    `SELECT *
FROM EVENT born
WITH [
    person WHERE @ids IN (
        "john.connor@gmail.com",
        "sarah.connor@gmail.com"
    )
    USING IDENTITY by-email
];`,
  ),
  { kind: 'hr' },
  P([
    "A database that doesn't just store data, but remembers, connects, reconciles, and evolves its understanding of the world over time.",
    true,
  ]),
  P(
    ['A database where ', false],
    ['time is a first-class citizen, identity is dynamic, schemas evolve, and relationships are more than simple links.', true],
  ),
  P([
    'Exactly the kind of foundation modern AI needs to move beyond static knowledge and fragmented memory.',
    false,
  ]),
].map((b) => ({
  ...b,
  length: b.kind === 'hr' ? 1 : b.text ? b.text.length : b.segs.reduce((n, [t]) => n + t.length, 0),
}));

const TOTAL = BLOCKS.reduce((n, b) => n + b.length, 0);

const KEYWORDS =
  /\b(?:UPSERT|ENTITIES|ENTITY|INSERT|EVENTS|EVENT|SELECT|FROM|WHERE|AND|HISTORY|AS|OF|ADD|IDENTITY|ON|USING|RULES|FOR|DECIMAL|MERGE|SUM|TEXT|PARTICIPANTS|WITH|IN)\b/;
const TOKEN = new RegExp(`("[^"]*"?|@\\w+|\\$\\w+|${KEYWORDS.source})`, 'g');

function highlight(text) {
  return text.split(TOKEN).map((part, i) => {
    if (i % 2 === 0) return part;
    const cls = part.startsWith('"') ? 'tok-str' : /^[@$]/.test(part) ? 'tok-var' : 'tok-kw';
    return (
      <span key={i} className={cls}>
        {part}
      </span>
    );
  });
}

function sliceSegs(segs, count) {
  const out = [];
  let left = count;
  for (const [text, bold] of segs) {
    if (left <= 0) break;
    const part = text.slice(0, left);
    left -= part.length;
    out.push(bold ? <b key={out.length}>{part}</b> : part);
  }
  return out;
}

export default function TypedDoc({ delayMs, top }) {
  const [started, setStarted] = useState(false);
  const [count, setCount] = useState(0);
  const [more, setMore] = useState(false);
  const scrollRef = useRef(null);

  useEffect(() => {
    let raf = 0;
    let startedAt = 0;
    const tick = (now) => {
      startedAt ||= now;
      const n = Math.min(TOTAL, Math.floor(((now - startedAt) / 1000) * CHARS_PER_SECOND));
      setCount(n);
      if (n < TOTAL) raf = requestAnimationFrame(tick);
    };
    const showCaret = setTimeout(() => setStarted(true), delayMs);
    const startTyping = setTimeout(() => (raf = requestAnimationFrame(tick)), delayMs + CARET_LEAD_MS);
    return () => {
      clearTimeout(showCaret);
      clearTimeout(startTyping);
      cancelAnimationFrame(raf);
    };
  }, [delayMs]);

  // the text never scrolls by itself; a pulsing hint shows while there is more below the fold
  const updateMore = () => {
    const el = scrollRef.current;
    if (el) setMore(el.scrollHeight - el.scrollTop - el.clientHeight > 24);
  };
  useEffect(updateMore, [count, started]);
  useEffect(() => {
    window.addEventListener('resize', updateMore);
    return () => window.removeEventListener('resize', updateMore);
  }, []);

  const scrollDown = () => {
    const el = scrollRef.current;
    el.scrollBy({ top: el.clientHeight * 0.75, behavior: 'smooth' });
  };

  let left = count;
  const blocks = [];
  if (started) {
    for (let i = 0; i < BLOCKS.length; i++) {
      const b = BLOCKS[i];
      if (left <= 0 && i > 0) break;
      const n = Math.min(left, b.length);
      left -= n;
      const typing = count < TOTAL && left === 0;
      const caret = typing ? <span className="typed-caret" /> : null;
      if (b.kind === 'hr') {
        if (n > 0) blocks.push(<hr key={i} />);
        if (caret) blocks.push(<p key={`${i}c`}>{caret}</p>);
      } else if (b.kind === 'code') {
        blocks.push(
          <pre key={i} className="typed-code">
            <code>
              {highlight(b.text.slice(0, n))}
              {caret}
            </code>
          </pre>,
        );
      } else {
        const Tag = b.kind === 'h3' ? 'h3' : 'p';
        blocks.push(
          <Tag key={i} className={b.kind === 'title' ? 'typed-title' : undefined}>
            {sliceSegs(b.segs, n)}
            {caret}
          </Tag>,
        );
      }
    }
  }

  return (
    <>
      <div ref={scrollRef} onScroll={updateMore} className="typed-doc" style={{ top }}>
        <div className="typed-doc-inner">{blocks}</div>
      </div>
      <button type="button" className={`typed-more${more ? ' is-visible' : ''}`} onClick={scrollDown}>
        Scroll to see more
        <span aria-hidden="true">↓</span>
      </button>
    </>
  );
}
