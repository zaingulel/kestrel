# Publishing the docs site online

The publishing workflow reads the token `CLOUDFLARE_API_TOKEN` only in the two jobs that run in the environment the
repository variable `DOCS_SITE_ENVIRONMENT` names. Each job's first step confirms that this environment admits
deployments only from the sole Branch `main` rule and fails the job otherwise, so no step receives the token until
that variable names such an environment. Each step that receives the token then refuses a missing or malformed
`CLOUDFLARE_ACCOUNT_ID` or `CLOUDFLARE_PAGES_PROJECT` variable before it sends any request. The site profile and its
brand folder, the environment with its secret, the variables and the Cloudflare Pages project and sign-in are the
repository's own, which no install or update writes.

Before publishing starts, and again whenever the token, its environment, the variables, the destination, its domains
or its readers change, read back names and settings only, never a value, in this order. The environment holds the
secret `CLOUDFLARE_API_TOKEN` and admits deployments only from the sole Branch `main` rule. Neither the repository's
own Actions secrets nor the organization secrets shared with it hold a secret of that name, which the workflow cannot
tell apart and would read whenever the environment lacks its own. No variable named `CLOUDFLARE_ACCOUNT_ID`,
`CLOUDFLARE_PAGES_PROJECT` or `DOCS_SITE_ENVIRONMENT` is defined on the environment or shared by an organization, since
either would stand in for the repository's own. The Pages project named for publishing exists in the account named for
it, with `main` as its production branch. The profile's `url` is the project's own address, `https://` and the project's
subdomain, whenever the repository has a published release, since each release site's address is built from it;
otherwise it may also be one of the project's custom domains. A Cloudflare Access sign-in admits only the approved
readers' emails on the project's address, every address under it and every custom domain. A publishing run checks the
environment's rule, the secret's presence, the variables' form and that the Pages project answers the token. It cannot
see the project's production branch, the profile's address or the Access sign-in, so only this read-back checks them.
Only then set the repository variables, `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_PAGES_PROJECT` first and
`DOCS_SITE_ENVIRONMENT` last, so no step receives the token before all three are set.
