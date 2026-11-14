/* Squad Depth: football rarity trivia (vanilla JS + Supabase JS v2). */

// ───────────────────────── Configuration ─────────────────────────
// Supabase dashboard > Connect (or Settings > API Keys).
// Use the publishable key (or the older "anon" key). Both are safe to ship
// in a public page. NEVER put the secret / service_role key here.
const SUPABASE_URL = 'https://jyyzhvyblfpovyxzsqgi.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_cKLNSIwyWlMJ1t3iAhu4IQ_ixoxQHij';

const MAX_WRONG_GUESSES = 2;    // second wrong guess on a question = sent off
const JACKPOT_LABEL = 'KriLLiON';
// ──────────────────────────────────────────────────────────────────

(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const views = ['loading', 'start', 'error', 'question', 'result', 'leaderboard'];
  const el = {
    home: $('home-btn'),
    scoreboard: $('scoreboard'),
    progress: $('progress'),
    totalScore: $('total-score'),
    dailyForm: $('daily-form'),
    username: $('username-input'),
    dailyStart: $('daily-start'),
    startFeedback: $('start-feedback'),
    leaderboardLink: $('leaderboard-link'),
    freeStart: $('free-start'),
    errorTitle: $('error-title'),
    errorBody: $('error-body'),
    errorRetry: $('error-retry'),
    prompt: $('prompt'),
    form: $('guess-form'),
    input: $('guess-input'),
    submit: $('guess-submit'),
    feedback: $('feedback'),
    skip: $('skip-btn'),
    resultPrompt: $('result-prompt'),
    resultCard: $('result-card'),
    resultJackpot: $('result-jackpot'),
    resultAnswer: $('result-answer'),
    resultLine: $('result-line'),
    resultDetail: $('result-detail'),
    resultPct: $('result-pct'),
    resultPoints: $('result-points'),
    pitch: $('pitch'),
    rarestList: $('rarest-list'),
    mostPickedList: $('most-picked-list'),
    next: $('next-btn'),
    boardTitle: $('board-title'),
    boardLine: $('board-line'),
    board: $('board'),
    boardFree: $('board-free'),
    boardRefresh: $('board-refresh'),
    jackpotName: $('jackpot-name'),
  };

  const state = {
    mode: null,          // 'daily' | 'free'
    pool: [],            // every active question { id, prompt }
    dailyIds: [],        // today's five, kept out of free play
    questions: [],       // the questions being played
    index: 0,
    score: 0,
    wrong: 0,
    busy: false,
    username: '',
  };

  let db = null;

  // ───────────────────────── Small helpers ─────────────────────────

  // localStorage can be unavailable (private mode); the game works without it.
  const store = {
    get(key) { try { return localStorage.getItem(key); } catch (e) { return null; } },
    set(key, value) { try { localStorage.setItem(key, value); } catch (e) { /* ignore */ } },
  };

  // A random id for this browser. It ties a leaderboard name to this device for the day.
  function deviceToken() {
    let token = store.get('sd_token');
    if (!token) {
      token = (window.crypto && crypto.randomUUID)
        ? crypto.randomUUID()
        : 'sd-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
      store.set('sd_token', token);
    }
    return token;
  }
  const TOKEN = deviceToken();

  function show(name) {
    for (const v of views) $('view-' + v).hidden = v !== name;
    window.scrollTo(0, 0);
  }

  function shuffle(list) {
    const a = list.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function ordinal(n) {
    const tens = n % 100;
    if (tens >= 11 && tens <= 13) return n + 'th';
    return n + (['th', 'st', 'nd', 'rd'][n % 10] || 'th');
  }

  // Keep ranges like "2008–09" on one line.
  function noBreak(text) {
    return text.replace(/(\d[–-])(\d)/g, '$1⁠$2');
  }

  function formatPct(pct, pickCount) {
    if (pickCount === 0) return '0%';
    if (pct < 0.1) return '<0.1%';
    return (pct >= 10 ? Math.round(pct) : pct.toFixed(1).replace(/\.0$/, '')) + '%';
  }

  function setMessage(target, text, cardClass) {
    target.textContent = '';
    if (!text) return;
    if (cardClass) {
      const card = document.createElement('span');
      card.className = cardClass;
      card.setAttribute('aria-hidden', 'true');
      target.append(card);
    }
    const msg = document.createElement('span');
    msg.textContent = text;
    target.append(msg);
  }

  async function rpc(name, args) {
    try {
      const { data, error } = await db.rpc(name, args);
      if (error) console.error(error);
      return error ? null : data;
    } catch (e) {
      console.error(e);
      return null;
    }
  }

  function currentQuestion() {
    return state.questions[state.index];
  }

  function isLastDailyQuestion() {
    return state.mode === 'daily' && !state.questions.some((q, i) => i > state.index && !q.done);
  }

  function updateScoreboard() {
    el.scoreboard.hidden = false;
    el.progress.textContent = state.mode === 'daily'
      ? `Daily: question ${state.index + 1} of ${state.questions.length}`
      : 'Free play';
    el.totalScore.textContent = state.score;
  }

  function setBusy(busy) {
    state.busy = busy;
    el.submit.disabled = busy;
    el.skip.disabled = busy;
    el.submit.textContent = busy ? 'Checking…' : 'Lock in answer';
  }

  function showError(title, body, canRetry) {
    el.scoreboard.hidden = true;
    el.errorTitle.textContent = title;
    el.errorBody.textContent = body;
    el.errorRetry.hidden = !canRetry;
    show('error');
  }

  // ───────────────────────── Theme ─────────────────────────

  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    store.set('sd_theme', theme);
    for (const radio of document.querySelectorAll('input[name="theme"]')) {
      radio.checked = radio.value === theme;
    }
  }

  // ───────────────────────── Start screen ─────────────────────────

  async function init() {
    el.jackpotName.textContent = JACKPOT_LABEL;
    applyTheme(document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');

    if (SUPABASE_URL.includes('YOUR_SUPABASE') || SUPABASE_ANON_KEY.includes('YOUR_SUPABASE')) {
      showError('Connect your Supabase project',
        'Open app.js and replace SUPABASE_URL and SUPABASE_ANON_KEY with the values from your Supabase project, then reload.', false);
      return;
    }
    if (!window.supabase) {
      showError('The Supabase library did not load',
        'Check your connection or any content blocker, then try again.', true);
      return;
    }
    db = db || window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

    show('loading');
    const [{ data: questions, error }, daily] = await Promise.all([
      db.from('questions').select('id, prompt').eq('is_active', true),
      rpc('get_daily_challenge', {}),
    ]);

    if (error || !questions) {
      console.error(error);
      showError('Could not load the questions',
        'The game could not reach its database. Check your connection and try again.', true);
      return;
    }
    if (questions.length === 0) {
      showError('No questions yet', 'Add at least one active question in Supabase, then reload.', true);
      return;
    }
    if (!daily) {
      showError('The daily challenge is not set up yet',
        'Run daily_challenge.sql in the Supabase SQL Editor, then reload.', true);
      return;
    }

    state.pool = questions;
    state.dailyIds = daily.question_ids || [];
    showStart();
  }

  function showStart() {
    state.mode = null;
    el.scoreboard.hidden = true;
    el.username.value = store.get('sd_username') || '';
    setMessage(el.startFeedback, '');
    show('start');
  }

  // ───────────────────────── Daily challenge ─────────────────────────

  async function startDaily(event) {
    event.preventDefault();
    const name = el.username.value.trim();
    if (name.length < 2) {
      setMessage(el.startFeedback, 'Type a name of at least 2 characters for the leaderboard.');
      el.username.focus();
      return;
    }

    el.dailyStart.disabled = true;
    const data = await rpc('start_daily', { p_username: name, p_token: TOKEN });
    el.dailyStart.disabled = false;

    if (!data) {
      setMessage(el.startFeedback, 'Could not start the challenge. Check your connection and try again.');
      return;
    }
    if (data.status !== 'ok') {
      setMessage(el.startFeedback, data.message);
      el.username.select();
      return;
    }

    state.mode = 'daily';
    state.username = data.username;
    state.score = data.score;
    state.questions = data.questions;
    store.set('sd_username', data.username);

    const firstOpen = state.questions.findIndex((q) => !q.done);
    if (data.finished || firstOpen === -1) {
      showLeaderboard();          // already played today
      return;
    }
    state.index = firstOpen;
    showQuestion();
  }

  async function showLeaderboard() {
    el.scoreboard.hidden = true;
    el.board.textContent = '';
    el.boardLine.textContent = 'Loading…';
    show('leaderboard');
    el.boardTitle.focus({ preventScroll: true });

    const data = await rpc('get_daily_leaderboard', {});
    if (!data) {
      el.boardLine.textContent = 'Could not load the leaderboard. Check your connection and refresh.';
      return;
    }

    const entries = data.entries || [];
    const mine = entries.find((e) => state.username && e.username.toLowerCase() === state.username.toLowerCase());
    if (mine) {
      el.boardLine.textContent = `${mine.username}, you scored ${mine.score} and sit ${ordinal(mine.rank)} of ${entries.length}. A new five arrives tomorrow.`;
    } else if (entries.length) {
      el.boardLine.textContent = `${entries.length} ${entries.length === 1 ? 'player has' : 'players have'} finished today's five.`;
    } else {
      el.boardLine.textContent = '';
    }

    if (entries.length === 0) {
      const li = document.createElement('li');
      li.className = 'board__empty';
      li.textContent = "Nobody has finished today's challenge yet. Be the first.";
      el.board.append(li);
      return;
    }
    for (const entry of entries) {
      const li = document.createElement('li');
      if (entry === mine) li.className = 'is-yours';
      const rank = document.createElement('span');
      rank.className = 'board__rank';
      rank.textContent = entry.rank;
      const name = document.createElement('span');
      name.className = 'board__name';
      name.textContent = entry.username;
      const score = document.createElement('span');
      score.className = 'board__score';
      score.textContent = entry.score;
      li.append(rank, name, score);
      el.board.append(li);
    }
  }

  // ───────────────────────── Free play ─────────────────────────

  function freePlayDeck(avoidId) {
    const allowed = state.pool.filter((q) => !state.dailyIds.includes(q.id));
    const deck = shuffle(allowed);
    // Don't open a new lap with the question that just closed the last one.
    if (deck.length > 1 && deck[0].id === avoidId) deck.push(deck.shift());
    return deck;
  }

  function startFree() {
    const deck = freePlayDeck(null);
    if (deck.length === 0) {
      setMessage(el.startFeedback, "Free play needs more questions than today's five. Add some in Supabase.");
      return;
    }
    state.mode = 'free';
    state.questions = deck;
    state.index = 0;
    state.score = 0;
    showQuestion();
  }

  // ───────────────────────── Playing a question ─────────────────────────

  function showQuestion() {
    const question = currentQuestion();
    state.wrong = question.wrong || 0;      // a resumed daily question may already have a yellow card
    setBusy(false);
    el.input.value = '';
    el.input.removeAttribute('aria-invalid');
    el.prompt.textContent = noBreak(question.prompt);
    setMessage(el.feedback, state.wrong > 0
      ? "You already have a yellow card on this one: one more wrong guess and you're sent off."
      : '', state.wrong > 0 ? 'card' : null);
    updateScoreboard();
    show('question');
    el.input.focus();
  }

  async function submitGuess(event) {
    event.preventDefault();
    if (state.busy) return;

    const guess = el.input.value.trim();
    if (!guess) {
      setMessage(el.feedback, 'Type an answer first.');
      el.input.focus();
      return;
    }

    setBusy(true);
    const question = currentQuestion();
    const data = state.mode === 'daily'
      ? await rpc('submit_daily_guess', { p_username: state.username, p_token: TOKEN, p_question_id: question.id, p_guess: guess })
      : await rpc('submit_guess', { p_question_id: question.id, p_guess: guess });
    setBusy(false);

    if (!data) {
      setMessage(el.feedback, 'Your answer did not get through. Check your connection and lock it in again.');
      return;
    }

    if (data.status === 'correct') {
      showHit(data);
    } else if (data.status === 'incorrect') {
      handleMiss(guess, data);
    } else {
      setMessage(el.feedback, data.message || 'Something went wrong. Try again.');
    }
  }

  function handleMiss(guess, data) {
    state.wrong += 1;
    // In the daily challenge the database keeps count; in free play the page does.
    const sentOff = state.mode === 'daily' ? Boolean(data.sent_off) : state.wrong >= MAX_WRONG_GUESSES;
    if (sentOff) {
      showNoScore('Sent off',
        `“${guess}” is not a valid answer either. That's a second wrong guess, so no points for this one.`, true);
      return;
    }
    el.input.setAttribute('aria-invalid', 'true');
    setMessage(el.feedback,
      `“${guess}” is not a valid answer. That's a yellow card: one more wrong guess and you're sent off.`, 'card');
    el.input.select();
    el.input.focus();
  }

  async function skipQuestion() {
    if (state.busy) return;
    if (state.mode === 'daily') {
      setBusy(true);
      const data = await rpc('submit_daily_guess',
        { p_username: state.username, p_token: TOKEN, p_question_id: currentQuestion().id, p_guess: null });
      setBusy(false);
      if (!data || data.status !== 'skipped') {
        setMessage(el.feedback, (data && data.message) || 'Could not skip. Check your connection and try again.');
        return;
      }
    }
    showNoScore('Skipped', 'No points for this one.');
  }

  // Fills one of the two small tables on the result screen.
  function renderTable(listEl, rows, yourAnswer) {
    listEl.textContent = '';
    for (const row of rows || []) {
      const li = document.createElement('li');
      const yours = row.answer === yourAnswer;
      if (yours) li.className = 'is-yours';

      const name = document.createElement('span');
      name.textContent = yours ? `${row.answer} (you)` : row.answer;

      const pct = document.createElement('span');
      pct.className = 'table__pct';
      const value = Number(row.pick_pct);
      pct.textContent = value === 0 ? '0%' : formatPct(value, 1);

      li.append(name, pct);
      listEl.append(li);
    }
    listEl.closest('.table').hidden = !rows || rows.length === 0;
  }

  function showResultShell() {
    currentQuestion().done = true;
    el.resultPrompt.textContent = noBreak(currentQuestion().prompt);
    el.next.textContent = isLastDailyQuestion() ? 'See the leaderboard' : 'Next question';
    el.totalScore.textContent = state.score;
    show('result');
    el.next.focus({ preventScroll: true });
  }

  // A valid answer.
  function showHit(data) {
    const pct = Number(data.pick_pct);
    const points = Number(data.score);
    const jackpot = Boolean(data.is_krillion);

    state.score = state.mode === 'daily' ? Number(data.daily_total) : state.score + points;

    el.resultCard.hidden = true;
    el.resultJackpot.hidden = !jackpot;
    el.resultJackpot.textContent = JACKPOT_LABEL;
    el.resultAnswer.textContent = data.answer;

    if (data.pick_count === 0) {
      el.resultLine.textContent = `Nobody had picked this before you. There are ${data.answer_count} valid answers.`;
    } else if (data.popularity_rank === 1) {
      el.resultLine.textContent = `The most-picked answer of all ${data.answer_count}. Dig deeper next time.`;
    } else {
      el.resultLine.textContent = `${ordinal(data.popularity_rank)} most-picked of ${data.answer_count} valid answers.`;
    }

    el.resultDetail.hidden = false;
    el.resultPct.textContent = formatPct(pct, data.pick_count);
    el.resultPoints.textContent = '+' + points;
    renderTable(el.rarestList, data.rarest, data.answer);
    renderTable(el.mostPickedList, data.most_picked, data.answer);

    // Ball starts on the left goal line, then runs to where the score puts it.
    // A jackpot carries it past the far goal line into the net.
    el.pitch.classList.toggle('pitch--goal', jackpot);
    el.pitch.style.setProperty('--run', '0');
    showResultShell();
    const run = jackpot ? 1.02 : Math.min(points, 99) / 100;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      el.pitch.style.setProperty('--run', String(run));
    }));
  }

  // Skipped, or sent off after too many wrong guesses.
  function showNoScore(title, line, redCard = false) {
    el.resultCard.hidden = !redCard;
    el.resultJackpot.hidden = true;
    el.resultAnswer.textContent = title;
    el.resultLine.textContent = line;
    el.resultDetail.hidden = true;
    showResultShell();
  }

  function nextQuestion() {
    if (state.mode === 'daily') {
      const nextOpen = state.questions.findIndex((q, i) => i > state.index && !q.done);
      if (nextOpen === -1) {
        showLeaderboard();
        return;
      }
      state.index = nextOpen;
    } else {
      state.index += 1;
      if (state.index >= state.questions.length) {      // end of the lap: reshuffle and keep going
        const last = state.questions[state.questions.length - 1].id;
        state.questions = freePlayDeck(last);
        state.index = 0;
      }
    }
    showQuestion();
  }

  // ───────────────────────── Wiring ─────────────────────────

  el.home.addEventListener('click', () => { if (db && state.pool.length) showStart(); });
  el.dailyForm.addEventListener('submit', startDaily);
  el.leaderboardLink.addEventListener('click', showLeaderboard);
  el.freeStart.addEventListener('click', startFree);
  el.boardFree.addEventListener('click', startFree);
  el.boardRefresh.addEventListener('click', showLeaderboard);
  for (const radio of document.querySelectorAll('input[name="theme"]')) {
    radio.addEventListener('change', () => applyTheme(radio.value));
  }

  el.form.addEventListener('submit', submitGuess);
  el.input.addEventListener('input', () => el.input.removeAttribute('aria-invalid'));
  el.skip.addEventListener('click', skipQuestion);
  el.next.addEventListener('click', nextQuestion);
  el.errorRetry.addEventListener('click', init);

  init();
})();
