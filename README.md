# r3f-optimizer-mcp

MCP-сервер для анализа и оптимизации веб-приложений на **three.js** и **React Three Fiber** под устройства разной производительности: слабые смартфоны, ноутбуки со встроенной графикой и настольные ПК с дискретными видеокартами.

Сервер работает по протоколу [Model Context Protocol](https://modelcontextprotocol.io). К нему может подключиться любой MCP-совместимый агент или IDE. Те же функции доступны из командной строки, в том числе в CI.

## Возможности

- **Статический анализ кода** (AST, Babel) для JS/JSX/TS/TSX: 11 правил, которые находят типичные причины низкой производительности WebGL-сцен.
- **Автоматическое исправление кода** под профиль устройства. Правки детерминированные, сохраняют исходное форматирование и возвращаются в виде unified diff. По умолчанию включён режим dry-run.
- **Анализ glTF/GLB-моделей**: число треугольников, draw calls, размеры текстур, сжатие.
- **Оптимизация моделей**: упрощение сетки (meshoptimizer), сжатие Meshopt, ресайз текстур и конвертация в WebP. Можно сгенерировать отдельные версии `model.low.glb`, `model.mid.glb` и `model.high.glb`.
- **Генерация runtime-модуля** для приложения: определяет класс устройства в браузере (GPU, ядра CPU, память, экран), отдаёт настройки качества через `useQuality()` и автоматически понижает качество при падении FPS.

## Профили устройств

| Параметр | low | mid | high |
|---|---|---|---|
| Максимальный DPR | 1 | 1.5 | 2 |
| MSAA (antialias) | нет | да | да |
| Карты теней | нет | ≤ 1024 | ≤ 2048 |
| Сегменты процедурной геометрии | ≤ 16 | ≤ 32 | ≤ 64 |
| Постобработка | выкл. | multisampling 2 | без ограничений |
| MeshPhysicalMaterial / transmission | нет | нет | да |
| Максимальный размер текстуры | 1024 | 2048 | 4096 |
| Бюджет треугольников на модель | 50 000 | 200 000 | 1 000 000 |
| Коэффициент упрощения сетки | 0.5 | 0.75 | 1 |

## Правила анализа

| Правило | Категория | Автоисправление | Что проверяет |
|---|---|---|---|
| `pixel-ratio` | rendering | да | `dpr` у `<Canvas>`, `renderer.setPixelRatio()` без ограничения сверху |
| `antialias` | rendering | да | MSAA на слабых устройствах (`<Canvas gl>`, `new WebGLRenderer()`) |
| `shadows` | rendering | да | карты теней и их разрешение (`shadow-mapSize`, `shadow.mapSize`) |
| `postprocessing` | rendering | да | `<EffectComposer>` и его multisampling |
| `geometry-segments` | geometry | да | детализация `sphereGeometry`, `TorusKnotGeometry` и т.д. (JSX, drei, three.js) |
| `physical-material` | materials | да | `MeshPhysicalMaterial`, `MeshTransmissionMaterial` |
| `instancing-candidate` | geometry | нет | списки `<mesh>` через `.map()`, где лучше подойдёт инстансинг |
| `alloc-in-frame-loop` | runtime | нет | `new Vector3()` / геометрии / материалы внутри `useFrame` и `requestAnimationFrame` |
| `setstate-in-frame-loop` | runtime | нет | вызовы `setState` внутри `useFrame` |
| `asset-preload` | loading | да | `useGLTF` / `useTexture` без `.preload()` |
| `adaptive-performance` | runtime | да | отсутствие `<AdaptiveDpr>` / `<AdaptiveEvents>` / `<PerformanceMonitor>` |

## Установка

```bash
git clone https://github.com/Spoon221/r3f-optimizer-mcp.git
cd r3f-optimizer-mcp
npm install      # заодно соберёт dist/
```

Нужен Node.js 20 или новее.

## Подключение к агентам

Сервер поддерживает два транспорта:

- **stdio** (по умолчанию): агент сам запускает процесс.
- **Streamable HTTP**: `node dist/index.js --http --port 3333`, адрес `http://127.0.0.1:3333/mcp`.

### Claude Code

```bash
claude mcp add r3f-optimizer -- node /абсолютный/путь/r3f-optimizer-mcp/dist/index.js
```

### Cursor / Windsurf / Claude Desktop / Cline

Добавьте в конфигурацию MCP (`.cursor/mcp.json`, `claude_desktop_config.json` и т.п.):

```json
{
  "mcpServers": {
    "r3f-optimizer": {
      "command": "node",
      "args": ["/абсолютный/путь/r3f-optimizer-mcp/dist/index.js"]
    }
  }
}
```

### VS Code (GitHub Copilot)

`.vscode/mcp.json`:

```json
{
  "servers": {
    "r3f-optimizer": {
      "type": "stdio",
      "command": "node",
      "args": ["/абсолютный/путь/r3f-optimizer-mcp/dist/index.js"]
    }
  }
}
```

### Через HTTP (удалённые агенты)

```bash
node dist/index.js --http --port 3333 --host 0.0.0.0
```

```json
{ "mcpServers": { "r3f-optimizer": { "type": "http", "url": "http://<host>:3333/mcp" } } }
```

Проверка работоспособности: `GET /health` возвращает `ok`.

> HTTP-режим даёт доступ к файловой системе машины, на которой запущен сервер. Открывайте его только в доверенной сети.

## Инструменты MCP

| Инструмент | Назначение |
|---|---|
| `list_profiles` | профили устройств и их лимиты |
| `list_rules` | список правил с обоснованием |
| `analyze_project` | анализ всех исходников проекта и список 3D-моделей |
| `analyze_file` | анализ одного файла |
| `optimize_code` | применение автоисправлений, возвращает diff (`dryRun: true` по умолчанию) |
| `analyze_asset` | статистика и проблемы glTF/GLB-модели |
| `optimize_asset` | оптимизированная копия модели под профиль |
| `generate_asset_variants` | генерация `*.low.glb`, `*.mid.glb`, `*.high.glb` |
| `scaffold_adaptive_runtime` | добавляет в проект модули `deviceTier` и `QualityProvider` |

Есть также промпт `optimize-project` с пошаговым сценарием: анализ → diff → применение → модели → runtime.

## Командная строка

```bash
npx r3f-optimizer analyze ./my-app --profile low     # отчёт; код выхода 1, если найдены ошибки
npx r3f-optimizer fix ./my-app --profile low         # показать diff
npx r3f-optimizer fix ./my-app --profile low --write # применить
npx r3f-optimizer asset public/models/car.glb --profile mid
npx r3f-optimizer variants public/models/car.glb     # car.low.glb / car.mid.glb / car.high.glb
npx r3f-optimizer scaffold ./my-app
npx r3f-optimizer rules
```

Любую команду можно запустить с флагом `--json` для машинной обработки результатов, например для сравнения «до/после».

## Адаптация во время выполнения

`scaffold_adaptive_runtime` создаёт в проекте два модуля:

- `deviceTier.(js|ts)`: функция `detectTier()` присваивает устройству класс по набору признаков (строка рендерера GPU через `WEBGL_debug_renderer_info`, `hardwareConcurrency`, `deviceMemory`, мобильный форм-фактор, число пикселей экрана). Есть ручное переопределение через `?quality=low` или `localStorage.quality`, а `modelUrl()` подставляет нужную версию модели.
- `QualityProvider.(jsx|tsx)`: React-контекст `useQuality()` и компонент `<AdaptiveQuality>`. Он понижает класс устройства (high → mid → low), если `PerformanceMonitor` из drei фиксирует устойчивое падение FPS.

```jsx
const q = useQuality();
<Canvas dpr={q.dpr} shadows={q.shadows} gl={{ antialias: q.antialias }}>
  <AdaptiveQuality>
    <sphereGeometry args={[1, q.segments, q.segments]} />
  </AdaptiveQuality>
</Canvas>
```

## Архитектура

```
src/
  index.ts          точка входа MCP (stdio / HTTP)
  server.ts         регистрация инструментов и промптов
  cli.ts            интерфейс командной строки
  engine.ts         запуск правил, применение исправлений, обход проекта
  ast.ts            разбор кода (Babel), обход дерева, работа с импортами
  profiles.ts       профили устройств
  rules/            правила анализа (rendering, scene, runtime)
  assets/gltf.ts    анализ и оптимизация glTF (gltf-transform, meshoptimizer)
  scaffold.ts       генерация runtime-модулей для целевого проекта
```

Каждое правило получает AST файла и профиль устройства, а находки сообщает вместе с функцией исправления. Исправления применяются через `magic-string` точечными заменами по позициям узлов AST. Поэтому код вне изменённых мест остаётся байт-в-байт прежним, а повторный запуск ничего не меняет.

## Разработка

```bash
npm run dev        # запуск сервера из исходников (tsx)
npm test           # тесты (vitest)
npm run typecheck
npm run build
```

## Лицензия

MIT
