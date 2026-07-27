# Geo Discovery Core (GDE-02)

Generic discovery engine. **No vertical business logic.**

## Run tests

```bash
node --test geo_discovery/discovery_engine.test.js
```

## HTTP

- `POST /geo/discover`
- `POST /geo/clusters`
- `GET /geo/places/:id`
- `GET /geo/categories`
- `POST /geo/places` (auth)
- `PUT /geo/places/:id` (auth)

## Docs SSOT

`docs/geo_discovery_engine/` — version `0.3.0-core`
