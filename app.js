/* Squad Depth: football rarity trivia (vanilla JS + Supabase JS v2). */

// ───────────────────────── Configuration ─────────────────────────
// Supabase dashboard > Project Settings > API.
// Use the "anon" key (or the newer "publishable" key). Both are safe to ship
// in a public page. NEVER put the service_role / secret key here.
const SUPABASE_URL = 'https://jyyzhvyblfpovyxzsqgi.supabase.co';            // e.g. https://abcdefgh.supabase.co
const SUPABASE_ANON_KEY = 'sb_publishable_cKLNSIwyWlMJ1t3iAhu4IQ_ixoxQHij';

const QUESTIONS_PER_GAME = 5;   // fewer are used if fewer are active
const MAX_WRONG_GUESSES = 2;    // second wrong guess on a question = sent off
const JACKPOT_LABEL = 'KriLLiON';
// ──────────────────────────────────────────────────────────────────

(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const views = ['loading', 'error', 'question', 'result', 'summary'];
  const el = {
    scoreboard: $('scoreboard'),
    progress: $('progress'),
    totalScore: $('total-score'),
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
    resultPctLabel: $('result-pct-label'),
    resultPoints: $('result-points'),
    pitch: $('pitch'),
    next: $('next-btn'),
    summaryTitle: $('summary-title'),
    summaryLine: $('summary-line'),
    recap: $('recap'),
    again: $('again-btn'),
    jackpotName: $('jackpot-name'),
  };

  const state = {
    pool: [],        // every active question
    questions: [],   // this game's questions
    index: 0,
    score: 0,
    wrong: 0,
    busy: false,
    history: [],     // { prompt, answer, points, pct }
  };

  let db = null;

  // ───────────────────────── Helpers ─────────────────────────

  function show(name) {
    for (const v of views) $('view-' + v).hidden = v !== name;
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
    return text.replace(/(\d[–-])(\d)/g, '$1\u2060$2');
  }

  function formatPct(pct, pickCount) {
    if (pickCount === 0) return '0%';
    if (pct < 0.1) return '<0.1%';
    return (pct >= 10 ? Math.round(pct) : pct.toFixed(1).replace(/\.0$/, '')) + '%';
  }

  function currentQuestion() {
    return state.questions[state.index];
  }

  function isLastQuestion() {
    return state.index === state.questions.length - 1;
  }

  function updateScoreboard() {
    el.scoreboard.hidden = false;
    el.progress.textContent = `Question ${state.index + 1} of ${state.questions.length}`;
    el.totalScore.textContent = state.score;
  }

  function setFeedback(text, cardClass) {
    el.feedback.textContent = '';
    if (!text) return;
    if (cardClass) {
      const card = document.createElement('span');
      card.className = cardClass;
      card.setAttribute('aria-hidden', 'true');
      el.feedback.append(card);
    }
    const msg = document.createElement('span');
    msg.textContent = text;
    el.feedback.append(msg);
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

  // ───────────────────────── Game flow ─────────────────────────

  async function init() {
    el.jackpotName.textContent = JACKPOT_LABEL;

    if (SUPABASE_URL.includes('YOUR_SUPABASE') || SUPABASE_ANON_KEY.includes('YOUR_SUPABASE')) {
      showError(
        'Connect your Supabase project',
        'Open app.js and replace SUPABASE_URL and SUPABASE_ANON_KEY with the values from your Supabase project settings, then reload.',
        false
      );
      return;
    }
    if (!window.supabase) {
      showError(
        'The Supabase library did not load',
        'Check your connection or any content blocker, then try again.',
        true
      );
      return;
    }

    db = db || window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    await loadQuestions();
  }

  async function loadQuestions() {
    show('loading');
    const { data, error } = await db.from('questions').select('id, prompt').eq('is_active', true);

    if (error) {
      console.error(error);
      showError(
        'Could not load the questions',
        'The game could not reach its database. Check your connection and try again.',
        true
      );
      return;
    }
    if (!data || data.length === 0) {
      showError(
        'No questions yet',
        'Add at least one active question in Supabase (the setup script includes two), then reload.',
        true
      );
      return;
    }

    state.pool = data;
    startGame();
  }

  function startGame() {
    state.questions = shuffle(state.pool).slice(0, QUESTIONS_PER_GAME);
    state.index = 0;
    state.score = 0;
    state.history = [];
    showQuestion();
  }

  function showQuestion() {
    state.wrong = 0;
    setBusy(false);
    setFeedback('');
    el.input.value = '';
    el.input.removeAttribute('aria-invalid');
    el.prompt.textContent = noBreak(currentQuestion().prompt);
    updateScoreboard();
    show('question');
    el.input.focus();
  }

  async function submitGuess(event) {
    event.preventDefault();
    if (state.busy) return;

    const guess = el.input.value.trim();
    if (!guess) {
      setFeedback('Type an answer first.');
      el.input.focus();
      return;
    }

    setBusy(true);
    const question = currentQuestion();
    let data, error;
    try {
      ({ data, error } = await db.rpc('submit_guess', { p_question_id: question.id, p_guess: guess }));
    } catch (e) {
      error = e;
    }
    setBusy(false);

    if (error || !data) {
      console.error(error);
      setFeedback('Your answer did not get through. Check your connection and lock it in again.');
      return;
    }

    if (data.status === 'correct') {
      showHit(data);
    } else if (data.status === 'incorrect') {
      handleMiss(guess);
    } else {
      setFeedback(data.message || 'Something went wrong. Try again.');
    }
  }

  function handleMiss(guess) {
    state.wrong += 1;
    if (state.wrong >= MAX_WRONG_GUESSES) {
      showNoScore(
        'Sent off',
        `“${guess}” is not a valid answer either. That's a second wrong guess, so no points for this one.`,
        true
      );
      return;
    }
    const left = MAX_WRONG_GUESSES - state.wrong;
    el.input.setAttribute('aria-invalid', 'true');
    setFeedback(
      `“${guess}” is not a valid answer. That's a yellow card: ${left === 1 ? 'one more wrong guess' : left + ' more wrong guesses'} and you're sent off.`,
      'card'
    );
    el.input.select();
    el.input.focus();
  }

  function showResultShell() {
    el.resultPrompt.textContent = noBreak(currentQuestion().prompt);
    el.next.textContent = isLastQuestion() ? 'See final score' : 'Next question';
    el.totalScore.textContent = state.score;
    show('result');
    el.next.focus({ preventScroll: true });
  }

  // A valid answer.
  function showHit(data) {
    const pct = Number(data.pick_pct);
    const points = Number(data.score);
    const jackpot = Boolean(data.is_krillion);

    state.score += points;
    state.history.push({ prompt: currentQuestion().prompt, answer: data.answer, points, jackpot, pct: formatPct(pct, data.pick_count) });

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
    el.resultPctLabel.textContent = 'of players picked this';
    el.resultPoints.textContent = '+' + points;

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
    state.history.push({ prompt: currentQuestion().prompt, answer: null, points: 0, pct: null, note: title });
    el.resultCard.hidden = !redCard;
    el.resultJackpot.hidden = true;
    el.resultAnswer.textContent = title;
    el.resultLine.textContent = line;
    el.resultDetail.hidden = true;
    showResultShell();
  }

  function nextQuestion() {
    if (isLastQuestion()) {
      showSummary();
      return;
    }
    state.index += 1;
    showQuestion();
  }

  function showSummary() {
    const n = state.questions.length;
    const jackpots = state.history.filter((h) => h.jackpot).length;
    el.scoreboard.hidden = true;
    el.summaryTitle.textContent = `Full time: ${state.score} points`;
    el.summaryLine.textContent =
      `Out of a possible ${n * 100} across ${n} question${n === 1 ? '' : 's'}` +
      (jackpots ? `, with ${jackpots} ${JACKPOT_LABEL}${jackpots === 1 ? '' : 's'}.` : '.');

    el.recap.textContent = '';
    for (const h of state.history) {
      const li = document.createElement('li');

      const answer = document.createElement('span');
      answer.className = 'recap__answer' + (h.answer ? '' : ' recap__answer--none');
      answer.textContent = h.answer ? `${h.answer} (${h.pct})` : h.note;

      const points = document.createElement('span');
      points.className = 'recap__points' + (h.points ? '' : ' recap__points--none');
      points.textContent = h.points ? '+' + h.points : '0';

      const prompt = document.createElement('span');
      prompt.className = 'recap__prompt';
      prompt.textContent = noBreak(h.prompt);

      li.append(answer, points, prompt);
      el.recap.append(li);
    }

    show('summary');
    el.summaryTitle.focus({ preventScroll: true });
  }

  // ───────────────────────── Wiring ─────────────────────────

  el.form.addEventListener('submit', submitGuess);
  el.input.addEventListener('input', () => el.input.removeAttribute('aria-invalid'));
  el.skip.addEventListener('click', () => {
    if (state.busy) return;
    showNoScore('Skipped', 'No points for this one.');
  });
  el.next.addEventListener('click', nextQuestion);
  el.again.addEventListener('click', startGame);
  el.errorRetry.addEventListener('click', init);

  init();
})();
