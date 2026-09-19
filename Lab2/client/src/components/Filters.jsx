// Фильтры списка. Любое изменение уходит в state приложения, оттуда —
// новым GET-запросом к API. Перезагрузки страницы не происходит.
export default function Filters({ statuses, filter, counts, onChange, onReset }) {
  const tabs = [{ value: 'all', label: 'Все' }, ...statuses];

  return (
    <div className="filters">
      <nav className="tabs" aria-label="Фильтр по статусу">
        {tabs.map((tab) => (
          <button
            key={tab.value}
            type="button"
            className={`tab tab--${tab.value} ${filter.status === tab.value ? 'tab--active' : ''}`}
            aria-pressed={filter.status === tab.value}
            onClick={() => onChange({ status: tab.value })}
          >
            {tab.label} <span className="tab__count">{counts[tab.value] ?? 0}</span>
          </button>
        ))}
      </nav>

      <div className="filters__form">
        <input
          className="filters__search"
          type="search"
          value={filter.q}
          onChange={(event) => onChange({ q: event.target.value })}
          placeholder="Поиск по названию и описанию"
          aria-label="Поиск задач"
        />
        <select
          value={filter.sort}
          onChange={(event) => onChange({ sort: event.target.value })}
          aria-label="Сортировка"
        >
          <option value="dueDate">По сроку</option>
          <option value="created">По дате создания</option>
          <option value="title">По названию</option>
        </select>
        <button className="btn btn--ghost" type="button" onClick={onReset}>
          Сбросить
        </button>
      </div>
    </div>
  );
}
