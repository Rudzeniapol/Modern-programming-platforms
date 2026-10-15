// Отрисовка поля на <canvas>.
//
// Рисуем не по таймеру, а по требованию: requestDraw() ставит флаг, и кадр
// рисуется в ближайшем requestAnimationFrame. Цикл продолжается, только пока
// есть анимации (вспышки клеток), — в покое браузер ничего не перерисовывает.

const CELL = 16; // логический размер клетки в CSS-пикселях
const REMOTE_FLASH_MS = 450;
const CONFLICT_FLASH_MS = 1100;
const CURSOR_TTL_MS = 5000;

/**
 * Итоговая карта раунда (история, итоги раунда): один пиксель холста на клетку.
 * До нужного размера холст растягивает CSS с image-rendering: pixelated — клетки остаются
 * чёткими квадратами. Пустые клетки прозрачные: их цвет — фон холста из CSS, поэтому
 * карта сама подстраивается под светлую и тёмную тему.
 */
export function drawFinalBoard(canvas, { width, height, cells }, teams) {
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  for (let i = 0; i < cells.length; i += 1) {
    if (cells[i] === '.') continue;
    ctx.fillStyle = teams[Number(cells[i])].color;
    ctx.fillRect(i % width, Math.floor(i / width), 1, 1);
  }
}

export class BoardRenderer {
  constructor(canvas, state, handlers) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.state = state;
    this.handlers = handlers;
    this.hover = null;
    this.flashes = new Map(); // "x:y" → { kind, until }
    this.cursors = new Map(); // id игрока → { name, team, x, y, at }
    this.frame = null;
    this.colors = this.readColors();

    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      this.colors = this.readColors();
      this.requestDraw();
    });
    window.addEventListener('resize', () => this.resize());
    // Курсоры ушедших без прощания игроков исчезают сами.
    setInterval(() => {
      if (this.cursors.size) this.requestDraw();
    }, 1000);

    canvas.addEventListener('pointermove', (event) => this.onPointerMove(event));
    canvas.addEventListener('pointerleave', () => {
      this.hover = null;
      this.handlers.onHover(null);
      this.requestDraw();
    });
    canvas.addEventListener('click', (event) => {
      const cell = this.cellAt(event);
      if (cell) this.handlers.onCellClick(cell.x, cell.y);
    });
  }

  readColors() {
    const style = getComputedStyle(document.documentElement);
    return {
      empty: style.getPropertyValue('--cell-empty').trim() || '#eef0f5',
      grid: style.getPropertyValue('--cell-grid').trim() || 'rgba(0,0,0,.06)',
      text: style.getPropertyValue('--text').trim() || '#1d2433'
    };
  }

  /** Размер холста в физических пикселях с учётом devicePixelRatio — чтобы линии были чёткими. */
  resize() {
    if (!this.state.board) return;
    const { width, height } = this.state.board;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = width * CELL * dpr;
    this.canvas.height = height * CELL * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.requestDraw();
  }

  /** Клетка под указателем. Холст масштабируется CSS, поэтому считаем через реальный размер на экране. */
  pointToBoard(event) {
    const rect = this.canvas.getBoundingClientRect();
    const { width, height } = this.state.board;
    return {
      fx: ((event.clientX - rect.left) / rect.width) * width,
      fy: ((event.clientY - rect.top) / rect.height) * height
    };
  }

  cellAt(event) {
    if (!this.state.board) return null;
    const { fx, fy } = this.pointToBoard(event);
    const x = Math.floor(fx);
    const y = Math.floor(fy);
    if (x < 0 || y < 0 || x >= this.state.board.width || y >= this.state.board.height) return null;
    return { x, y };
  }

  onPointerMove(event) {
    if (!this.state.board) return;
    const cell = this.cellAt(event);
    if (!cell || !this.hover || cell.x !== this.hover.x || cell.y !== this.hover.y) {
      this.hover = cell;
      this.handlers.onHover(cell);
      this.requestDraw();
    }
    const { fx, fy } = this.pointToBoard(event);
    this.handlers.onCursorMove(fx, fy);
  }

  flash(x, y, kind) {
    const duration = kind === 'conflict' ? CONFLICT_FLASH_MS : REMOTE_FLASH_MS;
    this.flashes.set(`${x}:${y}`, { x, y, kind, until: performance.now() + duration, duration });
    this.requestDraw();
  }

  setCursor(id, cursor) {
    if (cursor.x === null) this.cursors.delete(id);
    else this.cursors.set(id, { ...cursor, at: performance.now() });
    this.requestDraw();
  }

  removeCursor(id) {
    this.cursors.delete(id);
    this.requestDraw();
  }

  requestDraw() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      this.draw();
    });
  }

  draw() {
    const { board, config, pending, player } = this.state;
    if (!board || !config) return;
    const ctx = this.ctx;
    const now = performance.now();
    const teamColor = (team) => config.teams[team].color;

    // Клетки поля.
    for (let y = 0; y < board.height; y += 1) {
      for (let x = 0; x < board.width; x += 1) {
        const team = board.team[y * board.width + x];
        ctx.fillStyle = team >= 0 ? teamColor(team) : this.colors.empty;
        ctx.fillRect(x * CELL, y * CELL, CELL, CELL);
      }
    }

    // Сетка.
    ctx.strokeStyle = this.colors.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 1; x < board.width; x += 1) {
      ctx.moveTo(x * CELL + 0.5, 0);
      ctx.lineTo(x * CELL + 0.5, board.height * CELL);
    }
    for (let y = 1; y < board.height; y += 1) {
      ctx.moveTo(0, y * CELL + 0.5);
      ctx.lineTo(board.width * CELL, y * CELL + 0.5);
    }
    ctx.stroke();

    // Свои ходы, ещё не подтверждённые сервером: полупрозрачная заливка и пунктир.
    if (player) {
      ctx.setLineDash([3, 2]);
      ctx.lineWidth = 2;
      for (const action of pending) {
        ctx.globalAlpha = 0.55;
        ctx.fillStyle = teamColor(player.team);
        ctx.fillRect(action.x * CELL, action.y * CELL, CELL, CELL);
        ctx.globalAlpha = 1;
        ctx.strokeStyle = this.colors.text;
        ctx.strokeRect(action.x * CELL + 1, action.y * CELL + 1, CELL - 2, CELL - 2);
      }
      ctx.setLineDash([]);
    }

    // Вспышки: белая — клетку только что закрасил другой игрок, красная — конфликт.
    for (const [key, flash] of this.flashes) {
      const left = flash.until - now;
      if (left <= 0) {
        this.flashes.delete(key);
        continue;
      }
      const t = left / flash.duration;
      if (flash.kind === 'conflict') {
        ctx.strokeStyle = `rgba(229, 72, 77, ${t})`;
        ctx.lineWidth = 3;
        ctx.strokeRect(flash.x * CELL + 1.5, flash.y * CELL + 1.5, CELL - 3, CELL - 3);
        ctx.beginPath();
        ctx.moveTo(flash.x * CELL + 4, flash.y * CELL + 4);
        ctx.lineTo(flash.x * CELL + CELL - 4, flash.y * CELL + CELL - 4);
        ctx.moveTo(flash.x * CELL + CELL - 4, flash.y * CELL + 4);
        ctx.lineTo(flash.x * CELL + 4, flash.y * CELL + CELL - 4);
        ctx.stroke();
      } else {
        ctx.fillStyle = `rgba(255, 255, 255, ${t * 0.7})`;
        ctx.fillRect(flash.x * CELL, flash.y * CELL, CELL, CELL);
      }
    }

    // Клетка под курсором — рамка цвета своей команды.
    if (this.hover) {
      ctx.lineWidth = 2;
      ctx.strokeStyle = player ? teamColor(player.team) : this.colors.text;
      ctx.strokeRect(this.hover.x * CELL + 1, this.hover.y * CELL + 1, CELL - 2, CELL - 2);
    }

    // Курсоры других игроков.
    ctx.font = '600 11px system-ui, sans-serif';
    ctx.textBaseline = 'top';
    for (const [id, cursor] of this.cursors) {
      if (now - cursor.at > CURSOR_TTL_MS) {
        this.cursors.delete(id);
        continue;
      }
      const px = cursor.x * CELL;
      const py = cursor.y * CELL;
      ctx.fillStyle = teamColor(cursor.team);
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(px + 10, py + 4);
      ctx.lineTo(px + 4, py + 10);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      const label = cursor.name;
      const textWidth = ctx.measureText(label).width;
      ctx.fillStyle = teamColor(cursor.team);
      ctx.fillRect(px + 9, py + 9, textWidth + 8, 15);
      ctx.fillStyle = '#fff';
      ctx.fillText(label, px + 13, py + 11);
    }

    // Анимация продолжается, только пока есть вспышки.
    if (this.flashes.size) this.requestDraw();
  }
}
