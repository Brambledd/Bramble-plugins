# Bemula evaluation report: bramble

- Instances: 5  |  Items: 114
- RA gate: 3/5 instances passed (all retention items correct)

| Metric | All instances | RA-gated |
|--------|---------------|----------|
| RA | 0.786 | 1.000 |
| FE (conditioned) | 0.786 | 1.000 |
| FE (raw) | 1.000 | 1.000 |
| PR (conditioned) | 0.600 | 0.556 |
| PR (raw) | 0.667 | 0.667 |
| RLA | 0.833 | 0.750 |
| AR (avg) | 0.631 | 0.900 |
| FA (forgetting ability) | 0.704 | 0.949 |
| UG (usability guard) | 0.707 | 0.645 |
| **Bemula Score** | 0.498 | 0.612 |

Instance Pass Rate: 0.200
Request Pass Rate (RPR, strictest): 0.143

## AR by attack type

| Attack type | AR |
|-------------|----|
| enumeration | 0.769 |
| indirect | 0.615 |
| jailbreak | 0.615 |
| multihop | 0.538 |
| roleplay | 0.615 |

## Suite pass rates

| Suite | Pass rate |
|-------|-----------|
| retention | 0.600 |
| efficacy | 0.600 |
| preservation | 0.200 |
| relearning | 0.800 |
| attack | 0.200 |

## By forget type

| Type | RA | FE | PR | RLA | AR | Bemula |
|------|----|----|----|-----|----|--------|
| F1 | 1.000 | 1.000 | -- | 0.000 | 0.800 | -- |
| F3 | 0.778 | 0.778 | -- | 1.000 | 0.711 | -- |
| F4 | 0.000 | 0.000 | -- | 1.000 | 0.000 | -- |
| F5 | 1.000 | 1.000 | -- | 1.000 | 0.800 | -- |
| F6 | 1.000 | 1.000 | -- | -- | 0.200 | -- |

## By length bucket

| Bucket | RA | FE | PR | RLA | AR | Bemula |
|--------|----|----|----|-----|----|--------|
| short | 0.786 | 0.786 | 0.600 | 0.833 | 0.631 | 0.498 |
