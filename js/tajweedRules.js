/**
 * Tajweed Rules Reference Page Renderer
 */
const TajweedRules = (() => {

  const CATEGORIES = [
    { key: 'madd', title: 'أحكام المدود', icon: 'fa-lines-leaning' },
    { key: 'noon', title: 'أحكام النون والميم الساكنة والتنوين', icon: 'fa-comment-nodes' },
    { key: 'pronounce', title: 'مخارج الحروف والإدغام', icon: 'fa-volume-low' }
  ];

  const MADD_DURATIONS = [
    { key: '2',       title: 'المدود التي تُمد حركتين فقط',                badge: 'حركتان', badgeColor: '#4caf50' },
    { key: '4-5',     title: 'المدود الجائزة (4 أو 5 حركات)',              badge: '4 / 5',   badgeColor: '#ff9100' },
    { key: '4-5-o',   title: 'المد الواجب المتصل (4 أو 5 حركات)',         badge: '4 / 5',   badgeColor: '#ff2d6c' },
    { key: '2-4-6',   title: 'المدود الجائزة عند الوقف (2 / 4 / 6 حركات)', badge: '2 / 4 / 6', badgeColor: '#ffc107' },
    { key: '6',       title: 'المدود اللزومية (6 حركات وجوباً)',           badge: '6',       badgeColor: '#d50000' }
  ];

  function esc(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function buildCard(rule) {
    const ex = rule.example || { before: '', target: '', after: '' };
    return `
      <article class="rule-card">
        <div class="rule-card-header">
          <span class="rule-dot" style="background-color: var(--color-${rule.id})"></span>
          <div class="rule-card-titles">
            <span class="rule-card-ar">${esc(rule.ar)}</span>
            <span class="rule-card-en">${esc(rule.en)}</span>
          </div>
        </div>
        <p class="rule-def">${esc(rule.def || '')}</p>
        <p class="rule-example">${esc(ex.before)}<span class="rule-example-target" style="color: var(--color-${rule.id})">${esc(ex.target)}</span>${esc(ex.after)}</p>
      </article>`;
  }

  function renderMaddSection(maddRules) {
    let html = `
      <section class="tajweed-category">
        <h3 class="tajweed-category-title"><i class="fa-solid fa-lines-leaning"></i> أحكام المدود</h3>`;

    MADD_DURATIONS.forEach(dur => {
      const durRules = maddRules.filter(r => r.dur === dur.key);
      if (!durRules.length) return;
      html += `
        <div class="madd-duration-group">
          <h4 class="madd-duration-title">
            <span class="madd-duration-badge" style="background:${dur.badgeColor}">${dur.badge}</span>
            ${esc(dur.title)}
          </h4>
          <div class="tajweed-rules-grid">
            ${durRules.map(buildCard).join('')}
          </div>
        </div>`;
    });

    html += `</section>`;
    return html;
  }

  function render() {
    const container = document.getElementById('tajweed-rules-container');
    if (!container) return;

    const rules = (typeof SettingsManager !== 'undefined' && SettingsManager.RULES_META) || [];

    if (!rules.length) {
      container.innerHTML = '<p class="rules-empty">لا توجد أحكام لعرضها.</p>';
      return;
    }

    let html = `
      <div class="tajweed-rules-intro">
        <h2>أحكام التجويد</h2>
        <p>دليل مختصر لأحكام التجويد مع أمثلة قرآنية ملوّنة بلون كل حكم.</p>
      </div>`;

    const maddRules = rules.filter(r => r.cat === 'madd' && r.dur);
    html += renderMaddSection(maddRules);

    CATEGORIES.filter(c => c.key !== 'madd').forEach(cat => {
      const catRules = rules.filter(r => r.cat === cat.key);
      if (!catRules.length) return;
      html += `
        <section class="tajweed-category">
          <h3 class="tajweed-category-title"><i class="fa-solid ${cat.icon}"></i> ${esc(cat.title)}</h3>
          <div class="tajweed-rules-grid">
            ${catRules.map(buildCard).join('')}
          </div>
        </section>`;
    });

    container.innerHTML = html;
  }

  return {
    render
  };
})();
