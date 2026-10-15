// Всё, что касается DOM вокруг поля: верхняя панель, боковые карточки,
// уведомления, диалог входа и итоги раунда. Данные игроков выводятся только
// через textContent (см. el в util.js) — внедрить HTML через имя нельзя.

import { drawFinalBoard } from './renderer.js';
import { el, formatDuration, formatTime, playedTeams, plural } from './util.js';

const $ = (id) => document.getElementById(id);

export class UI {
  constructor() {
    this.toastHost = $('toasts');
    this.joinDialog = $('join-dialog');
    this.selectedTeam = null;
  }

  // ---------------------------------------------------------------- соединение

  setConnection(status, { retryAt, latency, pending, offlineCopy } = {}) {
    const pill = $('net-status');
    pill.className = `net net--${status}`;
    const text = $('net-text');
    if (status === 'open') text.textContent = 'В сети';
    else if (status === 'connecting') text.textContent = 'Подключение…';
    else
      text.textContent = retryAt
        ? `Нет связи · повтор через ${Math.max(0, Math.ceil((retryAt - Date.now()) / 1000))} с`
        : 'Нет связи';
    $('net-ping').textContent =
      status === 'open' && latency !== null && latency !== undefined ? `${latency} мс` : '';

    const banner = $('banner');
    if (status === 'open') {
      banner.hidden = true;
      return;
    }
    banner.hidden = false;
    const parts = ['Нет соединения с сервером.'];
    if (offlineCopy) parts.push('Показана сохранённая копия поля.');
    parts.push(
      pending
        ? `Ходов в очереди: ${pending} — они сохранены и будут отправлены после переподключения.`
        : 'Можно продолжать рисовать — ходы сохранятся и уйдут после переподключения.'
    );
    banner.textContent = parts.join(' ');
  }

  // ---------------------------------------------------------------- раунд и игрок

  setRoundTimer(round, serverNow) {
    $('round-label').textContent = round ? `Раунд №${round.id}` : 'Раунд';
    $('round-timer').textContent = round ? formatDuration(round.endsAt - serverNow) : '--:--';
  }

  renderPlayer(state) {
    const card = $('me-card');
    const { player, config } = state;
    card.hidden = !player || !config;
    if (card.hidden) return;

    const team = config.teams[player.team];
    $('me-name').textContent = player.name;
    const badge = $('me-team');
    badge.textContent = team.name;
    badge.style.setProperty('--team', team.color);

    const { charges, chargesAt } = state.charges();
    const bar = $('charges');
    if (bar.childElementCount !== config.maxCharges) {
      bar.replaceChildren(
        ...Array.from({ length: config.maxCharges }, () => el('span', { className: 'charges__cell' }))
      );
    }
    [...bar.children].forEach((cell, i) => cell.classList.toggle('is-full', i < charges));
    bar.style.setProperty('--team', team.color);
    bar.style.setProperty('--count', config.maxCharges);
    $('charges-text').textContent =
      charges >= config.maxCharges
        ? `Заряды: ${charges}/${config.maxCharges}`
        : `Заряды: ${charges}/${config.maxCharges} · +1 через ${Math.ceil(
            (chargesAt + config.regenMs - state.serverNow()) / 1000
          )} с`;
    $('me-total').textContent = `Закрашено за всё время: ${player.pixelsTotal}`;
  }

  // ---------------------------------------------------------------- счёт

  renderScores(state, scores) {
    if (!state.config || !scores) return;
    const { teams } = state.config;
    const total = scores.totalCells;
    const leader = Math.max(...scores.teams.map((t) => t.cells));

    $('team-scores').replaceChildren(
      ...scores.teams.map(({ id, cells }) => {
        const team = teams[id];
        const share = total ? (cells / total) * 100 : 0;
        const fill = el('span', { className: 'score__fill' });
        fill.style.setProperty('--team', team.color);
        fill.style.setProperty('--share', `${share}%`);
        const row = el('li', { className: `score ${cells > 0 && cells === leader ? 'is-leader' : ''}` }, [
          el('span', { className: 'score__name', text: team.name }),
          el('span', { className: 'score__value', text: `${cells} · ${share.toFixed(1)}%` }),
          el('span', { className: 'score__bar' }, [fill])
        ]);
        return row;
      })
    );

    const top = $('top-players');
    if (!scores.players.length) {
      top.replaceChildren(el('li', { className: 'empty', text: 'Пока никто не рисовал' }));
    } else {
      top.replaceChildren(
        ...scores.players.map((p) =>
          el('li', {}, [
            el('span', { text: p.name }),
            el('span', { className: 'muted', text: String(p.pixels) })
          ])
        )
      );
    }
  }

  renderOnline(state, online) {
    if (!state.config || !online) return;
    const list = $('online');
    const items = online.players.map((p) => {
      const dot = el('span', { className: 'dot' });
      dot.style.setProperty('--team', state.config.teams[p.team].color);
      const isMe = state.player && p.id === state.player.id;
      return el('li', {}, [dot, el('span', { text: isMe ? `${p.name} (вы)` : p.name })]);
    });
    if (!items.length) items.push(el('li', { className: 'empty', text: 'Никого нет' }));
    list.replaceChildren(...items);
    $('spectators').textContent = online.spectators ? `· зрителей: ${online.spectators}` : '';
  }

  renderHistory(state, history) {
    if (!state.config || !history) return;
    const list = $('history');
    if (!history.length) {
      list.replaceChildren(
        el('li', {
          className: 'empty',
          text: 'Здесь появятся итоги завершённых раундов: итоговая карта и счёт команд'
        })
      );
      return;
    }
    list.replaceChildren(...history.map((round) => roundCard(state.config.teams, round)));
  }

  setCellInfo(state, cell) {
    const hint = $('board-hint');
    if (!cell || !state.board) {
      hint.textContent = state.player
        ? 'Кликните по клетке, чтобы закрасить её цветом своей команды'
        : 'Вы смотрите игру как зритель — войдите, чтобы рисовать';
      return;
    }
    const info = state.cell(cell.x, cell.y);
    const team = info.team >= 0 ? state.config.teams[info.team].name : 'пусто';
    const owner = info.owner ? ` · ${info.owner}` : '';
    hint.textContent = `(${cell.x}, ${cell.y}) — ${team}${owner} · версия ${info.version}`;
  }

  // ---------------------------------------------------------------- уведомления

  toast(text, type = 'info', ms = 4000) {
    const node = el('div', {
      className: `toast toast--${type}`,
      text,
      attrs: { role: type === 'error' ? 'alert' : 'status' }
    });
    this.toastHost.append(node);
    setTimeout(() => node.classList.add('is-leaving'), ms);
    setTimeout(() => node.remove(), ms + 400);
  }

  showRoundEnd(state, round) {
    const { teams } = state.config;
    const overlay = $('round-overlay');
    const winner = round.winnerTeam === null ? null : teams[round.winnerTeam];
    $('round-result').textContent = winner ? `Победили ${winner.name}!` : 'Ничья!';
    overlay.style.setProperty('--team', winner ? winner.color : '#888');
    const map = $('round-map');
    map.hidden = !round.board;
    if (round.board) drawFinalBoard(map, round.board, teams);
    $('round-details').textContent = playedTeams(round)
      .map(({ id, cells }) => `${teams[id].name}: ${cells}`)
      .join(' · ');
    overlay.hidden = false;
    clearTimeout(this.overlayTimer);
    this.overlayTimer = setTimeout(() => {
      overlay.hidden = true;
    }, 5000);
  }

  // ---------------------------------------------------------------- вход

  openJoin(state, { onSubmit, online }) {
    const dialog = this.joinDialog;
    const teams = $('join-teams');
    const counts = state.config.teams.map(() => 0);
    for (const p of (online && online.players) || []) counts[p.team] += 1;

    teams.replaceChildren(
      ...state.config.teams.map((team) => {
        const button = el(
          'button',
          {
            className: 'team-choice',
            attrs: { type: 'button', 'aria-pressed': String(this.selectedTeam === team.id) }
          },
          [
            el('span', { className: 'team-choice__name', text: team.name }),
            el('span', { className: 'team-choice__count', text: `онлайн: ${counts[team.id]}` })
          ]
        );
        button.style.setProperty('--team', team.color);
        button.addEventListener('click', () => {
          this.selectedTeam = team.id;
          for (const other of teams.children) other.setAttribute('aria-pressed', String(other === button));
          $('join-error').textContent = '';
        });
        return button;
      })
    );

    const form = $('join-form');
    form.onsubmit = (event) => {
      event.preventDefault();
      const name = $('join-name').value.trim();
      if (name.length < 2 || name.length > 20) {
        $('join-error').textContent = 'Имя — от 2 до 20 символов';
        return;
      }
      if (this.selectedTeam === null) {
        $('join-error').textContent = 'Выберите команду';
        return;
      }
      $('join-error').textContent = '';
      onSubmit({ name, team: this.selectedTeam });
    };
    $('join-spectate').onclick = () => dialog.close();
    if (!dialog.open) dialog.showModal();
  }

  setJoinError(text) {
    $('join-error').textContent = text;
  }

  closeJoin() {
    if (this.joinDialog.open) this.joinDialog.close();
  }
}

/**
 * Карточка завершённого раунда: номер и время, итоговая карта, результат и команды,
 * которые играли, — сколько клеток у каждой было к концу и сколько игроков участвовало.
 */
function roundCard(teams, round) {
  const winner = round.winnerTeam === null ? null : teams[round.winnerTeam];

  let map;
  if (round.board) {
    map = el('canvas', {
      className: 'round-card__map',
      attrs: { role: 'img', 'aria-label': `Итоговая карта раунда №${round.id}` }
    });
    drawFinalBoard(map, round.board, teams);
  } else {
    map = el('p', { className: 'muted small', text: 'Карта этого раунда не сохранилась' });
  }

  const played = playedTeams(round);
  const rows = played.map((team) => {
    const dot = el('span', { className: 'dot' });
    dot.style.setProperty('--team', teams[team.id].color);
    const share = round.scores.totalCells ? (team.cells / round.scores.totalCells) * 100 : 0;
    return el('li', {}, [
      dot,
      el('span', { text: teams[team.id].name }),
      team.players
        ? el('span', {
            className: 'muted',
            text: `${team.players} ${plural(team.players, ['игрок', 'игрока', 'игроков'])}`
          })
        : null,
      el('span', { className: 'round-card__value', text: `${team.cells} · ${share.toFixed(1)}%` })
    ]);
  });
  const absent = teams.filter((team) => !played.some((p) => p.id === team.id));

  const card = el('li', { className: 'round-card' }, [
    el('div', { className: 'round-card__head' }, [
      el('strong', { text: `Раунд №${round.id}` }),
      el('span', { className: 'muted', text: formatTime(round.finishedAt) })
    ]),
    map,
    el('p', { className: 'round-card__result', text: winner ? `Победили ${winner.name}` : 'Ничья' }),
    el('ul', { className: 'round-card__teams' }, rows),
    absent.length
      ? el('p', {
          className: 'muted small',
          text: `Не участвовали: ${absent.map((team) => team.name).join(', ')}`
        })
      : null
  ]);
  // Полоса сверху карточки — цвет победителя.
  if (winner) card.style.setProperty('--team', winner.color);
  return card;
}
