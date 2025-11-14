# Adding Remote Support and Authentication to a Local MCP Server

A secure Playwright MCP server with authentication and role-based access control powered by [Descope](https://www.descope.com/). This project demonstrates how to add enterprise-grade security to MCP servers for safe remote access and team collaboration.

## How it Works

1. The MCP client, in this case, the MCP Inspector, registers with the proxy via the DCR.
2. It redirects you to the authentication/consent flow set up in the Descope console.
3. You log in and consent to the requested scopes.
4. Descope issues an access token to the MCP client.
5. The MCP client includes this token in its requests to the proxy server.
6. The proxy server validates the token before forwarding the request to the MCP server.

## Prerequisites

-   Node.js 18+
-   A [Descope account](https://www.descope.com/)
-   Follow along with the article to set up the Descope project

## Local Setup

1. Clone the repository:

    ```bash
    git clone https://github.com/kimanikevin254/descope-playwright-mcp-auth.git
    cd descope-playwright-mcp-auth
    ```

2. Install dependencies:

    ```bash
    npm install
    ```

3. Configure environment variables by copying the `.env.example` file and replacing the placeholder values with the actual project credentials from the [Descope Console](https://app.descope.com/):

    ```bash
    cp .env.example .env
    ```

4. Start the MCP server (Terminal 1):

    ```bash
    npm run start:mcp
    ```

5. Start the auth proxy (Terminal 2):

    ```bash
    npx nodemon --exec 'ts-node' src/auth-proxy.ts
    ```

6. Test with MCP Inspector (Terminal 3):

    ```bash
    npx @modelcontextprotocol/inspector@0.17.2 --transport http --server-url http://localhost:3000/mcp
    ```

    > If you have another machine running on the network, you can run the MCP Inspector on it with the command `npx @modelcontextprotocol/inspector@0.17.2 --transport http --server-url http://<AUTH-PROXY-MACHINE-IP>:3000/mcp`, where `<AUTH-PROXY-MACHINE-IP>` is the IP address of the machine that is running both the MCP server and the auth proxy.

7. Once the MCP Inspector UI launches, select **Connect** to connect to your MCP server.
