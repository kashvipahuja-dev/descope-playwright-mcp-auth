import "dotenv/config";
import express from "express";
import cors from "cors";
import httpProxy from "http-proxy";
import {
    descopeMcpAuthRouter,
    descopeMcpBearerAuth,
    DescopeMcpProvider,
} from "@descope/mcp-express";
import { Readable } from "stream";

const app = express();
app.use(cors());

const AUTH_PROXY_PORT = process.env.AUTH_PROXY_PORT || 3000;
const MCP_SERVER_PORT = process.env.MCP_SERVER_PORT || 3001;

const descopeProvider = new DescopeMcpProvider({
    projectId: process.env.DESCOPE_PROJECT_ID!,
    managementKey: process.env.DESCOPE_MANAGEMENT_KEY!,
    serverUrl: process.env.SERVER_URL!,

    dynamicClientRegistrationOptions: {
        authPageUrl: `https://api.descope.com/login/${process.env
            .DESCOPE_PROJECT_ID!}?flow=mcp-auth-consent`,
    },
});

// Add OAuth metadata and DCR endpoints
app.use(descopeMcpAuthRouter(undefined, descopeProvider));

// Protect your MCP endpoints with bearer authentication
app.use(["/mcp"], descopeMcpBearerAuth(descopeProvider));

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
                const authInfo = await descopeProvider.descope.validateJwt(
                    req?.auth?.token!
                );
                const isAdmin = descopeProvider.descope.validateRoles(
                    authInfo,
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