// Registers Convex Auth's JWT issuer with this deployment. Without this file
// sign-in "succeeds" but ctx.auth.getUserIdentity() is always null.
export default {
  providers: [
    {
      domain: process.env.CONVEX_SITE_URL,
      applicationID: "convex",
    },
  ],
};
