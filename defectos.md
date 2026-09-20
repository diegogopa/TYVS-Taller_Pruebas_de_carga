# Defectos de rendimiento

Este documento registra los defectos encontrados durante las pruebas de rendimiento realizadas sobre el servicio de registro de votantes.

Los defectos se documentan a partir de las mediciones obtenidas durante los escenarios Baseline, Load, Stress, Spike, Soak y Regression.

---

## PERF-01 — Errores de conexión durante Load Test

**Escenario:** Load Test
**Carga:** 0 → 200 VUs, permanencia en 200 VUs y descenso
**Duración:** 14 minutos

### Descripción

Durante la prueba de carga se presentaron errores técnicos de conexión contra el endpoint `/register`.

K6 registró solicitudes que no pudieron establecer conexión con el servidor:

```text
Post "http://localhost:8080/register": dial tcp 127.0.0.1:8080:
connectex: No connection could be made because the target machine
actively refused it.
```

### Resultado observado

* Solicitudes totales: **12.479.303**
* Solicitudes con error técnico: **1.082**
* Tasa de error técnico: **0,00867%**
* Threshold configurado: **< 1%**
* Threshold: **Cumplido**
* p95 de solicitudes HTTP 200: **18,35 ms**
* p99 de solicitudes HTTP 200: **< 800 ms**
* Resultados de negocio inesperados: **0%**

### Impacto

Durante algunos momentos de la prueba el servicio rechazó conexiones, provocando que determinadas solicitudes no pudieran ser procesadas.

Aunque el porcentaje de errores fue muy bajo y se mantuvo por debajo del threshold establecido, el comportamiento debe ser investigado porque representa una interrupción temporal del servicio bajo carga.

### Evidencia

Durante la ejecución de k6 se observaron múltiples mensajes `connection refused` alrededor de los minutos 12 y 12,5 de la prueba.

### Posible causa

La causa raíz no fue determinada con las mediciones realizadas.

Como líneas de investigación se pueden revisar:

* disponibilidad del servidor durante los intervalos de error;
* capacidad de aceptación de conexiones;
* recursos del sistema operativo;
* cantidad de conexiones concurrentes;
* administración de conexiones hacia la base de datos.

### Estado

**Abierto**

---

## PERF-02 — Degradación severa durante prueba Soak

**Escenario:** Soak Test
**Carga:** 100 VUs constantes
**Duración:** 2 horas

### Descripción

Durante la prueba prolongada se presentó una degradación significativa del servicio. Después de aproximadamente 36 minutos comenzaron a observarse solicitudes que superaban el timeout configurado de 2 segundos.

Los mensajes registrados por k6 fueron:

```text
Post "http://localhost:8080/register": request timeout
```

Los errores continuaron apareciendo durante la ejecución y al finalizar la prueba se superó ampliamente el threshold establecido para errores técnicos.

### Resultado observado

* Solicitudes totales: **47.889.811**
* Solicitudes con error técnico: **21.866.707**
* Tasa de error técnico: **45,66%**
* Threshold configurado: **< 1%**
* Threshold: **Incumplido**
* p95 de solicitudes HTTP 200: **15,52 ms**
* Máximo de duración HTTP: **5.473,14 ms**
* Resultados de negocio inesperados: **0%**
* VUs máximos: **100**

K6 finalizó indicando:

```text
thresholds on metrics 'http_req_failed, register_technical_failed' have been crossed
```

### Impacto

El defecto afecta una parte considerable de las solicitudes durante una ejecución prolongada.

Más de **21 millones de solicitudes** presentaron errores técnicos, por lo que el servicio no pudo mantener el nivel de disponibilidad esperado durante las dos horas de ejecución.

Después de finalizar la prueba también se verificó que el endpoint:

```text
http://localhost:8080/actuator/health
```

no respondía inicialmente.

Posteriormente, después de recuperar el servicio, el endpoint volvió a responder con:

```json
{"status":"UP"}
```

### Evidencia adicional

El proceso Java correspondiente al backend permanecía activo después de la prueba. Se identificó el proceso asociado al proyecto del taller mediante su línea de comandos.

En ese momento se observó aproximadamente:

* Memoria privada: **4,39 GB**
* CPU acumulada: **61.972 segundos**

Este dato se considera una evidencia adicional para investigación, pero **no permite afirmar por sí solo que exista una fuga de memoria**.

### Posible causa

La causa raíz no fue determinada.

El comportamiento puede estar relacionado con algún recurso que se degrada o se agota durante una ejecución prolongada, pero se requieren mediciones adicionales para determinar si el origen corresponde a:

* administración de conexiones;
* recursos del servidor;
* conexiones a la base de datos;
* hilos;
* sockets;
* memoria;
* u otro recurso utilizado por la aplicación.

No se debe considerar ninguna de estas hipótesis como causa confirmada con las pruebas realizadas.

### Recuperación y Regression

Después de recuperar el servicio se ejecutó una prueba de Regression con 20 VUs durante 5 minutos.

Los resultados fueron:

* Solicitudes: **3.773.003**
* Errores técnicos: **0%**
* `http_req_failed`: **0%**
* `register_technical_failed`: **0%**
* Checks: **100%**
* HTTP 200: **100%**
* `VALID`: **100%**
* p95: **2,84 ms**

Esto demuestra que, una vez recuperado el servicio, el comportamiento bajo una carga menor volvió a ser estable.

### Estado

**Abierto**

---

## Resumen de defectos

| ID      | Escenario | Problema                                                          |        Resultado | Threshold | Estado  |
| ------- | --------- | ----------------------------------------------------------------- | ---------------: | --------: | ------- |
| PERF-01 | Load      | Conexiones rechazadas temporalmente                               | 0,00867% errores |      < 1% | Abierto |
| PERF-02 | Soak      | Timeouts y pérdida de disponibilidad durante ejecución prolongada |   45,66% errores |      < 1% | Abierto |

---

## Observaciones generales

Los escenarios Baseline, Stress, Spike y Regression no presentaron errores técnicos y cumplieron los thresholds establecidos.

El escenario Load presentó errores de conexión puntuales, pero la tasa obtenida fue inferior al límite establecido del 1%.

El principal problema encontrado corresponde al escenario Soak. La prueba mostró una degradación importante durante la ejecución prolongada, con un 45,66% de errores técnicos y múltiples solicitudes que terminaron en timeout.

El escenario Regression posterior mostró que el sistema pudo volver a operar correctamente después de recuperar el servicio. Por esta razón, el defecto observado durante Soak debe investigarse principalmente desde la perspectiva del comportamiento del sistema bajo operación prolongada.

Las pruebas realizadas permiten identificar el comportamiento y la existencia del defecto, pero no permiten establecer con certeza la causa raíz. Se requieren mediciones adicionales de recursos del servidor, conexiones, memoria, hilos y base de datos para determinarla.
