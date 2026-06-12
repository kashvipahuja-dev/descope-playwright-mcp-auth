import "dotenv/config";
import express, { Request, Response } from "express";
import cors from "cors";
import httpProxy from "http-proxy";
import { DescopeMcpProvider } from "@descope/mcp-express";
import { createRemoteJWKSet, jwtVerify, decodeProtectedHeader, decodeJwt } from "jose";
import { Readable } from "stream";

const app = express();
app.use(express.json());
app.use(
  cors({
    origin: true,
    methods: "*",
    allowedHeaders: "Authorization, Origin, Content-Type, Accept, *",
  }),
);

app.use((req: any, res: any, next: any) => {
  console.log(`${req.method} ${req.path}`);
  next();
});

const AUTH_PROXY_PORT = process.env.AUTH_PROXY_PORT || 3000;
const MCP_SERVER_PORT = process.env.MCP_SERVER_PORT || 3001;
const serverUrl = process.env.SERVER_URL || `http://localhost:${AUTH_PROXY_PORT}`;
const descopeMcpServerIssuer = process.env.DESCOPE_MCP_SERVER_ISSUER;

if (!descopeMcpServerIssuer) {
  throw new Error("Missing required environment variable: DESCOPE_MCP_SERVER_ISSUER");
}

const descopeProvider = new DescopeMcpProvider({
  serverUrl: process.env.SERVER_URL!,
  descopeMcpServerWellKnownUrl: process.env.DESCOPE_MCP_SERVER_WELL_KNOWN_URL,
  projectId: process.env.DESCOPE_PROJECT_ID,
  baseUrl: process.env.DESCOPE_BASE_URL,
});

// Use the agentic JWKS URI (from /.well-known/openid-configuration jwks_uri field)
const agenticJwksUri = `${process.env.DESCOPE_BASE_URL || "https://api.descope.com"}/${process.env.DESCOPE_PROJECT_ID}/.well-known/jwks.json`;
const JWKS = createRemoteJWKSet(new URL(agenticJwksUri));

// Host the oauth-protected-resource endpoint manually
app.get("/.well-known/oauth-protected-resource", (_req: Request, res: Response) => {
  res.json({
    resource: `${serverUrl}/mcp`,
    authorization_servers: [descopeMcpServerIssuer],
  });
});

// Host the oauth-authorization-server endpoint manually
app.get("/.well-known/oauth-authorization-server", (_req: Request, res: Response) => {
  res.json({
    issuer: descopeMcpServerIssuer,
    authorization_endpoint: `https://api.descope.com/oauth2/v1/apps/agentic/${process.env.DESCOPE_PROJECT_ID}/${process.env.DESCOPE_MCP_SERVER_ID}/authorize`,
    token_endpoint: `https://api.descope.com/oauth2/v1/apps/agentic/${process.env.DESCOPE_PROJECT_ID}/${process.env.DESCOPE_MCP_SERVER_ID}/token`,
    response_types_supported: ["code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["client_secret_post"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    revocation_endpoint: `https://api.descope.com/oauth2/v1/apps/${process.env.DESCOPE_PROJECT_ID}/revoke`,
    registration_endpoint: `http://localhost:3000/register`,
    scopes_supported: ["openid", "profile"],
  });
});
// Bearer auth middleware — validates agentic OAuth tokens via jose directly
app.use(["/mcp"], async (req: any, res: any, next: any) => {
  try {
    const authHeader = req.headers.authorization;
    console.log("Auth header:", authHeader ? authHeader.substring(0, 50) + "..." : "MISSING");

    if (!authHeader) {
      return res.status(401).json({ error: "invalid_token", error_description: "Missing Authorization header" });
    }

    const [type, token] = authHeader.split(" ");
    if (type?.toLowerCase() !== "bearer" || !token) {
      return res.status(401).json({ error: "invalid_token", error_description: "Invalid Authorization header format, expected 'Bearer TOKEN'" });
    }

    // Decode header/payload without verification for debug visibility
    try {
      const header = decodeProtectedHeader(token);
      const claims = decodeJwt(token);
      console.log("Token header:", JSON.stringify(header));
      console.log("Token claims: iss:", claims.iss, "exp:", claims.exp, "sub:", claims.sub);
    } catch (decodeErr) {
      console.error("Could not decode token (malformed JWT?):", decodeErr);
    }

    try {
      const { payload } = await jwtVerify(token, JWKS, {
        issuer: descopeMcpServerIssuer,
        clockTolerance: 5,
      });
      console.log("Validation SUCCESS: iss:", payload.iss, "sub:", payload.sub);
      req.auth = { token, payload };
      next();
    } catch (err: any) {
      console.error("Validation FAILED:", err.code, err.message);
      return res.status(401).json({ error: "invalid_token", error_description: err.message });
    }
  } catch (err) {
    console.error("Unexpected error:", err);
    res.status(500).json({ error: "server_error" });
  }
});



// Create proxy instance targeting the localhost-bound MCP server
const proxy = httpProxy.createProxyServer({
  target: `http://localhost:${MCP_SERVER_PORT}`,
  changeOrigin: true,
  ws: false,
});

// Handle proxy errors
proxy.on("error", (err, req, res) => {
  console.error("Proxy error:", err);
  try {
    (res as any).writeHead?.(500, { "Content-Type": "text/plain" });
    (res as any).end?.("Proxy error");
  } catch (e) {
    // Ignore if already closed
  }
});

app.use("/mcp", express.json(), async (req: any, res: any, next: any) => {
  // Only check authorization for POST requests with a body
  if (req.method == "POST" && req.body) {
    const mcpReq = req.body;

    // Check if the MCP method is a tools call
    if (mcpReq.method === "tools/call") {
      const toolName = mcpReq.params?.name;
      console.log(`Accessing tool: ${toolName}`);

      // If the tool is an admin tool, verify user has admin role
      if (toolName === "browser_install") {
        // Re-use the already-validated payload from the auth middleware
        const authInfo = { jwt: req.auth.token, token: req.auth.payload };
        const isAdmin = descopeProvider.descope.validateRoles(
          authInfo as any,
          ["Tenant Admin"]
        );

        if (!isAdmin) {
          console.log(
            `Unauthorized access attempt to admin tool: ${toolName}`
          );
          return res.status(403).json({
            jsonrpc: "2.0",
            error: {
              code: -32000,
              message: `Access denied: Tool '${toolName}' requires Tenant Admin role.`,
            },
            id: mcpReq.id || null,
          });
        }
      }
    }

    // Convert object back to string for the proxy
    req.body = JSON.stringify(mcpReq);
    req.headers["content-length"] = Buffer.byteLength(req.body).toString();
  }

  next();
});

// Proxy all /mcp requests
app.use("/mcp", (req: any, res: any) => {
  proxy.web(req, res, {
    buffer: Readable.from([req.body ?? ""]),
  });
});

app.listen(AUTH_PROXY_PORT, () => {
  console.log(`Server running on port ${AUTH_PROXY_PORT}`);
});

process.on("SIGINT", () => {
  console.log("Shutting down server...");
  process.exit();
});