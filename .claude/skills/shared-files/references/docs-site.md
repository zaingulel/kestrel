# Publishing the docs site online

With `docsSite` set to `online`, the workflow `docs-site-build.yml` runs on each push to `main`. It builds the
pushed commit's site with no secret and no environment and keeps `docs-site/build` as the build output `docs-site`
for seven days. It publishes nothing: where and how the site is hosted is the repository's own choice, and no
install or update writes a publishing workflow, host account, credential or sign-in.

The output is the main branch's site. It names the newest published release and links no release site.

A host serves the output as it is when it serves the folder at the root of the `https` origin the profile's `url`
names, with no path, since the site's links start at that root.

The docs site install guide that comes with the workflow's distribution gives a worked example of publishing it.
