import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Rate, Counter } from 'k6/metrics';
import { SharedArray } from 'k6/data';

const BASE_URL   = __ENV.BASE_URL || 'http://localhost:8080';
const DATA_FILE  = __ENV.DATA_FILE || null;
const SCENARIO   = (__ENV.SCENARIO || 'baseline').toLowerCase();
const TIMEOUT_MS = Number(__ENV.TIMEOUT_MS || 2000);
const SLEEP_MS   = Number(__ENV.SLEEP_MS || 0);

const registerDuration = new Trend('register_duration');

// Métricas de resultados de negocio
const registerValid = new Rate('register_valid');
const registerDuplicated = new Rate('register_duplicated');
const registerBusinessUnexpected = new Rate('register_business_unexpected');

// Métrica exclusiva para errores técnicos / HTTP inesperados
const registerTechnicalFailed = new Rate('register_technical_failed');

const statusCount = new Counter('status_count');

function tryOpen(path) {
  try {
    return open(path);
  } catch (_) {
    return null;
  }
}

const persons = new SharedArray('persons', function () {
  let csvText = null;

  if (DATA_FILE) {
    csvText = tryOpen(DATA_FILE);

    if (!csvText) {
      throw new Error(
        `No se pudo abrir DATA_FILE='${DATA_FILE}'. Verifica la ruta.`
      );
    }
  } else {
    csvText = tryOpen('perf/data/persons.csv') || tryOpen('../data/persons.csv');

    if (!csvText) {
      throw new Error(
        'No se encontró persons.csv. Usa __ENV.DATA_FILE o ejecuta desde la raíz del repo.'
      );
    }
  }

  const lines = csvText.trim().split(/\r?\n/);
  lines.shift(); // Eliminar encabezado

  return lines.map((l) => {
    const parts = l.split(',');

    const [id, name, age, gender, alive] = parts.map((x) =>
      String(x).trim()
    );

    return {
      id: Number(id),
      name,
      age: Number(age),
      gender,
      alive: alive.toLowerCase() === 'true',
    };
  });
});

const ALL_SCENARIOS = {
  baseline: {
    executor: 'constant-vus',
    vus: 20,
    duration: '5m',
    gracefulStop: '30s',
  },

  load: {
    executor: 'ramping-vus',
    startVUs: 0,
    stages: [
      { duration: '2m', target: 200 },
      { duration: '10m', target: 200 },
      { duration: '2m', target: 0 },
    ],
    gracefulRampDown: '30s',
  },

  stress: {
    executor: 'ramping-vus',
    startVUs: 200,
    stages: [
      { duration: '5m', target: 600 },
      { duration: '3m', target: 600 },
      { duration: '2m', target: 0 },
    ],
    gracefulRampDown: '30s',
  },

  spike: {
    executor: 'ramping-vus',
    startVUs: 50,
    stages: [
      { duration: '1m', target: 300 },
      { duration: '2m', target: 50 },
      { duration: '1m', target: 0 },
    ],
    gracefulRampDown: '30s',
  },

  soak: {
    executor: 'constant-vus',
    vus: 100,
    duration: '2h',
    gracefulStop: '1m',
  },

  regression: {
    executor: 'constant-vus',
    vus: 20,
    duration: '5m',
    gracefulStop: '30s',
  },
};

function buildOptions() {
  const chosen = ALL_SCENARIOS[SCENARIO];

  if (!chosen) {
    console.warn(
      `SCENARIO='${SCENARIO}' no reconocido. Usando 'baseline'.`
    );
  }

  return {
    thresholds: {
      // Error técnico HTTP menor al 1%
      http_req_failed: ['rate<0.01'],

      // Rendimiento
      'http_req_duration{status:200}': [
        'p(95)<300',
        'p(99)<800',
      ],

      // Solo errores técnicos inesperados
      register_technical_failed: ['rate<0.01'],

      // No debe haber resultados de negocio inesperados
      register_business_unexpected: ['rate<0.01'],
    },

    scenarios: {
      run: chosen || ALL_SCENARIOS['baseline'],
    },

    discardResponseBodies: false,

    noConnectionReuse: false,
  };
}

export const options = buildOptions();

function buildUniqueId(baseId) {
  return (__VU * 1000000) + (__ITER % 1000000);
}

function nextPayload() {
  const p = persons[Math.floor(Math.random() * persons.length)];

  const uniqueId = buildUniqueId(p.id);

  return JSON.stringify({
    name: p.name,
    id: uniqueId,
    age: p.age,
    gender: p.gender,
    alive: p.alive,
  });
}

export default function () {
  const payload = nextPayload();

  const params = {
    headers: {
      'Content-Type': 'application/json',
    },

    timeout: `${TIMEOUT_MS}ms`,

    tags: {
      endpoint: '/register',
      scenario: SCENARIO,
    },
  };

  const res = http.post(
    `${BASE_URL}/register`,
    payload,
    params
  );

  registerDuration.add(
    res.timings.duration,
    params.tags
  );

  statusCount.add(1, {
    status: String(res.status),
  });

  const bodyText = String(res.body || '')
    .trim()
    .toUpperCase();

  /*
   * Clasificación de la respuesta
   *
   * HTTP 200 + VALID
   *     -> registro correcto
   *
   * HTTP 200 + DUPLICATED
   *     -> respuesta de negocio válida.
   *        No se considera error técnico.
   *
   * HTTP 200 + otro resultado conocido
   *     -> rechazo de negocio esperado.
   *
   * HTTP diferente de 200
   *     -> error técnico / HTTP.
   */

  const isHttpOk = res.status === 200;

  const isValid = isHttpOk && bodyText === 'VALID';

  const isDuplicated =
    isHttpOk && bodyText === 'DUPLICATED';

  const isKnownBusinessResult =
    isHttpOk &&
    (
      bodyText === 'VALID' ||
      bodyText === 'DUPLICATED' ||
      bodyText === 'INVALID' ||
      bodyText === 'UNDERAGE' ||
      bodyText === 'DEAD' ||
      bodyText === 'INVALID_AGE'
    );

  const isTechnicalFailure = !isHttpOk;

  const isBusinessUnexpected =
    isHttpOk && !isKnownBusinessResult;

  // Registrar métricas
  registerValid.add(isValid);

  registerDuplicated.add(isDuplicated);

  registerTechnicalFailed.add(isTechnicalFailure);

  registerBusinessUnexpected.add(isBusinessUnexpected);

  // Checks generales
  const ok = check(res, {
    'status 200': () => isHttpOk,

    'resultado de negocio válido': () =>
      isKnownBusinessResult,
  });

  /*
   * Mostrar errores técnicos o resultados inesperados.
   *
   * DUPLICATED NO se muestra como error porque
   * es una respuesta válida del negocio.
   */
  if (
    (!ok || isTechnicalFailure || isBusinessUnexpected) &&
    (__ITER % 1000 === 0)
  ) {
    console.error(
      `[ERR][${SCENARIO}] status=${res.status} body='${String(
        res.body
      ).slice(0, 160)}'`
    );
  }

  if (SLEEP_MS > 0) {
    sleep(SLEEP_MS / 1000.0);
  }
}

export function handleSummary(data) {
  const scen = SCENARIO || 'baseline';

  const path = `perf/results/summary-${scen}.json`;

  return {
    [path]: JSON.stringify(data, null, 2),
  };
}