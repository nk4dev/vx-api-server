<<<<<<< HEAD
# VX API SERVER

this is vx api server code.

## usage 
- check vx global version. => api.varius.technology/version
- vx api status => api.varius.technology/status

## another info
main repo : https://github.com/nk4dev/vx3
cli repo (vx3 git submodule): https://github.com/nk4dev/vx
=======
```txt
npm install
npm run dev
```

```txt
npm run deploy
```

[For generating/synchronizing types based on your Worker configuration run](https://developers.cloudflare.com/workers/wrangler/commands/#types):

```txt
npm run cf-typegen
```

Pass the `CloudflareBindings` as generics when instantiation `Hono`:

```ts
// src/index.ts
const app = new Hono<{ Bindings: CloudflareBindings }>()
```
>>>>>>> 4850fc6 (feat: 🎸 first commit)
