# Jibun 自分

Jibun is a web app for making fonts from your handwriting. I originally made it for myself as an alternative to Calligraphr. You can host a copy for yourself or let other people sign up on the same installation. Each person gets a private library for their fonts.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/omrajguru/jibun)

## Making your first font

Create an account, start a font, and choose the characters you want to draw. If you prefer pen and paper, Jibun gives you a printable sheet with a box for each character. Fill it in and photograph the page. Jibun uses the marks in the corners to straighten the photograph, then traces each character into an outline. You can also draw directly on screen.

Once you have a few letters, type a word in the preview. A letter can look fine in its box and still leave too much space beside the next one. You can adjust the spacing there, or make a smaller sheet for just the letters you want to write again. When you're happy with the result, export a TTF or OTF to install on your computer, or a WOFF2 to use on a website.

## Running locally

From the repository root, run this command to generate a local sign-in secret.

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Create a file named `.dev.vars` and paste the generated value after `BETTER_AUTH_SECRET=`.

```dotenv
BETTER_AUTH_SECRET=
DEV_MEMORY_STORAGE=1
```

Then install the dependencies, initialise the local database, and start the app.

```sh
npm ci
npm run db:migrate:local
npm run dev
```

Open `http://localhost:5173` and create an account. Local file storage is temporary, so restarting the Worker clears files kept in memory. Use S3 if you want those files to persist. To run the tests, use `npm test`.

## Hosting on Cloudflare

The deploy button copies Jibun to your Git account and sets up a Cloudflare Worker. D1 holds accounts and projects. Font builds run through a queue, and the Worker stores exported fonts, template PDFs, and optional scan backups in a private Amazon S3 bucket.

1. Create a private S3 bucket and choose a prefix for Jibun’s files. The default is `jibun/`. Give the Worker’s AWS credentials permission to read, write, and delete objects under that prefix and to list the prefix in the bucket.
2. Use the deploy button above. In your copy of `wrangler.jsonc`, set `BETTER_AUTH_URL` to the Worker’s public HTTPS origin. Set `S3_BUCKET` and `S3_REGION` to match your bucket, and change `S3_PREFIX` if you chose another prefix. Deploy those settings.
3. In the Worker’s **Settings → Variables and Secrets**, add `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and a newly generated `BETTER_AUTH_SECRET` as secrets. Use a different sign-in secret for each deployment.
4. From a local checkout of the repository Cloudflare created, run `npm ci`, `npx wrangler login`, and `npx wrangler d1 migrations apply DB --remote`. Open the deployed app and choose **Create an account**. Email signup requires a name, an email address, and a password of at least 12 characters. Jibun currently has no email verification or password reset by email.

To offer Google sign-in, add `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` as Worker secrets. In your Google OAuth client, register your public origin followed by `/api/auth/callback/google` as the redirect URI. MCP clients can connect to `/mcp` on the same origin.

## Upgrading a single-owner installation

Back up D1 and pause traffic before deploying the new Worker. The old version can recreate the database rules that restrict signup to the original owner. With traffic paused, deploy the new code and apply the remote migrations. Migration 0004 removes those rules and preserves the original account and its fonts. Reopen traffic when the migration finishes.
