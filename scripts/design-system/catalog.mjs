/* Browser entry, copied next to the generated bundle by export-tokens.mjs. */
const { React, ReactDOM, Balancita: DS, BalancitaTokenData: data } = window
const h = React.createElement
for (const { name, value } of data.tokens) {
  document.documentElement.style.setProperty(`--${name}`, value)
}
const element = (tag, className, text) => {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}
const token = (name) => {
  const found = data.tokens.find((t) => t.name === name)
  if (!found) throw new Error(`Missing catalog token: ${name}`)
  return found.value
}

document.getElementById('runtime-version').textContent =
  `React ${React.version}`
for (const item of data.tokens.filter((t) => t.type === 'color')) {
  const card = element('article', 'swatch')
  const color = element('div', 'swatch-color')
  color.style.backgroundColor = item.value
  card.append(
    color,
    element('code', '', item.name),
    element('p', 'mono', item.value),
  )
  if (data.usage[item.name])
    card.append(element('p', '', data.usage[item.name]))
  document.getElementById('palette').append(card)
}

for (const [name, sample, family] of [
  ['text-value', '79.771,00 USD', 'font-mono'],
  ['text-title', 'El contexto antes que la señal.', 'font-sans'],
  ['text-body', 'Lo que sabemos y lo que todavía falta.', 'font-sans'],
  ['text-label', 'ÚLTIMA ACTUALIZACIÓN · PF_XBTUSD', 'font-mono'],
]) {
  const card = element('article', 'specimen')
  const text = element('div', 'sample', sample)
  text.style.fontFamily = token(family)
  text.style.fontSize = token(name)
  text.style.lineHeight = token(`${name}--line-height`)
  card.append(
    text,
    element('p', 'mono', `${name} / ${token(name)} / ${family}`),
  )
  document.getElementById('type-specimens').append(card)
}

function preview(name, description, render, options) {
  const article = element('article', 'component')
  article.dataset.component = name
  const header = element('div', 'component-heading')
  const title = element('div')
  title.append(element('h3', '', name), element('p', '', description))
  header.append(title)
  const mount = element(
    'div',
    `preview${name === 'AppShell' || name === 'TopBar' ? ' shell-preview' : ''}`,
  )
  const code = element('code', 'code')
  const root = ReactDOM.createRoot(mount)
  const update = (value) => {
    const example = render(value)
    root.render(example.node)
    code.textContent = example.code
  }
  if (options) {
    const label = element('label', '', 'Variante')
    const select = element('select')
    select.setAttribute('aria-label', `Variante de ${name}`)
    for (const option of options) {
      const node = element('option', '', option)
      node.value = option
      select.append(node)
    }
    select.addEventListener('change', () => update(select.value))
    label.append(select)
    header.append(label)
  }
  article.append(header, mount, code)
  document.getElementById('component-previews').append(article)
  update(options?.[0])
}

preview(
  'Panel',
  'Un contenedor con contexto, acciones opcionales y cuerpo.',
  () => ({
    node: h(
      DS.Panel,
      {
        title: 'Posición en papel',
        eyebrow: 'PF_XBTUSD',
        actions: h(DS.StatusPill, { tone: 'nodata' }),
      },
      h(DS.Metric, {
        label: 'Exposición de ejemplo',
        value: '100,00 USD',
        hint: 'Demostración · No es una posición real',
      }),
    ),
    code: '<Panel title="Posición en papel" eyebrow="PF_XBTUSD" actions={<StatusPill tone="nodata" />}>\n  <Metric label="Exposición de ejemplo" value="100,00 USD" />\n</Panel>',
  }),
)
preview(
  'Metric',
  'Cifras ya formateadas: el componente no calcula ni redondea.',
  (tone) => ({
    node: h(DS.Metric, {
      label: 'Neto de ejemplo',
      value: tone === 'down' ? '−11,20 USD' : '11,20 USD',
      delta: 'Demostración',
      hint: 'Valor recibido del consumidor',
      tone,
    }),
    code: `<Metric label="Neto de ejemplo" value="${tone === 'down' ? '−11,20 USD' : '11,20 USD'}" tone="${tone}" />`,
  }),
  ['neutral', 'up', 'down'],
)
preview(
  'StatusPill',
  'Estado semántico. Sin datos nunca se muestra como saludable.',
  (tone) => ({
    node: h(DS.StatusPill, { tone }),
    code: `<StatusPill tone="${tone}" />`,
  }),
  ['nodata', 'ok', 'warn', 'bad'],
)
preview(
  'DataState',
  'Carga, error, vacío y ausencia de datos son condiciones distintas.',
  (kind) => ({
    node: h(DS.DataState, {
      kind,
      detail: 'Estado de demostración. No se infiere ningún dato ausente.',
    }),
    code: `<DataState kind="${kind}" detail="Estado de demostración." />`,
  }),
  ['loading', 'error', 'empty', 'unavailable', 'nodata'],
)
preview(
  'DataProvenance',
  'La hora del evento y la última recepción permanecen separadas.',
  (variant) => {
    const props =
      variant === 'Con datos'
        ? {
            origin: 'Ejemplo local',
            experiment: 'Demo',
            runId: 'demo-001',
            eventTime: 1800000000000,
            receivedAt: 1800000005000,
            now: 1800000009000,
          }
        : {}
    return {
      node: h(DS.DataProvenance, props),
      code:
        variant === 'Con datos'
          ? '<DataProvenance origin="Ejemplo local" experiment="Demo" runId="demo-001"\n  eventTime={1800000000000} receivedAt={1800000005000} now={1800000009000} />'
          : '<DataProvenance />',
    }
  },
  ['Sin datos', 'Con datos'],
)
const navigation = (current) =>
  [
    { href: '#components', label: 'Terminal', current: current === 'Terminal' },
    {
      href: '#components',
      label: 'Estrategias',
      current: current === 'Estrategias',
    },
  ].map((item, i) => ({ ...item, href: i === 0 ? '#components' : '#tokens' }))
preview(
  'TopBar',
  'Marca, navegación accesible y un área de estado compuesta.',
  (current) => ({
    node: h(DS.TopBar, {
      brandHref: '#overview',
      brandLabel: 'Inicio del catálogo',
      navigation: navigation(current),
      status: h(DS.StatusPill, { tone: 'warn' }, 'Demo'),
    }),
    code: `<TopBar brandHref="#overview" brandLabel="Inicio del catálogo"\n  navigation={[{ href: "#components", label: "${current}", current: true }]}\n  status={<StatusPill tone="warn">Demo</StatusPill>} />`,
  }),
  ['Terminal', 'Estrategias'],
)
preview(
  'AppShell',
  'La misma composición de navegación y contenido que utiliza la app.',
  () => ({
    node: h(
      DS.AppShell,
      {
        brandHref: '#overview',
        brandLabel: 'Inicio del catálogo',
        navigation: navigation('Terminal'),
        status: h(DS.StatusPill, { tone: 'nodata' }),
      },
      h(
        DS.Panel,
        {
          title: 'Una sola fuente de verdad',
          eyebrow: 'Ejemplo de composición',
        },
        h(DS.DataState, {
          kind: 'empty',
          detail: 'Los datos de este catálogo son ilustrativos.',
        }),
      ),
    ),
    code: '<AppShell brandHref="#overview" brandLabel="Inicio del catálogo"\n  navigation={navigation} status={<StatusPill tone="nodata" />}>\n  <Panel title="Una sola fuente de verdad"><DataState kind="empty" /></Panel>\n</AppShell>',
  }),
)

function renderTokens(query = '') {
  const rows = document.getElementById('token-rows')
  rows.replaceChildren()
  const tokens = data.tokens.filter((t) =>
    `${t.name} ${t.value} ${data.usage[t.name] ?? ''}`
      .toLocaleLowerCase('es')
      .includes(query.toLocaleLowerCase('es')),
  )
  for (const item of tokens) {
    const row = element('tr')
    row.append(
      element('td', 'mono', `--${item.name}`),
      element('td', 'mono', item.value),
      element('td', '', data.usage[item.name] ?? item.type),
    )
    rows.append(row)
  }
  document.getElementById('token-count').textContent =
    `${tokens.length} / ${data.tokens.length} tokens`
}
document
  .getElementById('token-search')
  .addEventListener('input', (event) => renderTokens(event.target.value))
renderTokens()
