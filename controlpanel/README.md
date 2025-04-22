# Control Panel

The static controlpanel files are included in ocean nodes so the control panel doesn't have to be rebuilt every time the node is built. If there are changes to the control panel it should be rebuilt with `npm run build:controlpanel`.

When you start your node the control panel will be made available at: `http://localhost:8000/controlpanel/`

## Local development

This is a [Next.js](https://nextjs.org/) project bootstrapped with [`create-next-app`](https://github.com/vercel/next.js/tree/canary/packages/create-next-app).

## Getting Started

First, run the development server:

```bash
npm i

npm run dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `pages/index.tsx`. The page auto-updates as you edit the file.

[API routes](https://nextjs.org/docs/api-routes/introduction) can be accessed on [http://localhost:3000/api/hello](http://localhost:3000/api/hello). This endpoint can be edited in `pages/api/hello.ts`.

The `pages/api` directory is mapped to `/api/*`. Files in this directory are treated as [API routes](https://nextjs.org/docs/api-routes/introduction) instead of React pages.

This project uses [`next/font`](https://nextjs.org/docs/basic-features/font-optimization) to automatically optimize and load Inter, a custom Google Font.

## Build & run

The control panel is built by default with the Ocean Node. Set the environmental variables and then run the following commands from the root of the project:

```
npm run build
npm run start
```

The control panel will be made available at: `http://localhost:8000/controlpanel/`
