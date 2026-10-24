# Load run 2026-10-24T02-54-25

`{"levels":[50],"users":400,"ramp":"30s","hold":"2m","holdSeconds":120,"session":"90","alerts":0.3,"latency":"150-600","fail525":0,"quota":0}`

| riders | requests | req/s | failed | p95 arrivals | p95 journeys | arrivals asked | EMT arrivals (all callers) | EMT arrivals ÷ asked | distinct stops | EMT calls (all) | EMT per rider-min | Supabase auth per request | pushes | stop polls | bike fan-out |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 50 | 1776 | 9.1 | 2.25% | 1841 ms | 4291 ms | 1344 | 1801 | 1.34 | 313 | 1978 | 12.17 | 0.73 | 188 | 3 | 0 |

### 50 riders: worker access log

| route | requests | statuses | p95 |
| --- | ---: | --- | ---: |
| GET /arrivals | 62 | 200×62 | 627 ms |
| GET /auth/config | 17 | 200×17 | 39 ms |
| GET /bikes/saved | 17 | 200×17 | 49 ms |
| GET /auth/me | 17 | 200×17 | 53 ms |
| GET /stops | 17 | 200×17 | 64 ms |
| GET /auth/emt | 17 | 200×17 | 84 ms |
| GET /bikes/nearby | 6 | 200×6 | 61 ms |
| GET /stops/nearby | 2 | 200×2 | 181 ms |
| GET /stops/:id/detail | 2 | 200×2 | 482 ms |
| GET /lines/:id/route | 2 | 200×2 | 394 ms |
| GET /live | 2 | 101×2 | 50 ms |
| POST /journeys | 1 | 200×1 | 3626 ms |

Runtime faults:

- 30× `✘ [ERROR] Uncaught Error: The Workers runtime canceled this request because it detected that your Worker's code had hung and would never gen`
- 20× `✘ [ERROR] Uncaught Error: Cannot perform I/O on behalf of a different request. I/O objects (such as streams, request/response bodies, and ot`
