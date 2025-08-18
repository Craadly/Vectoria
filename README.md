# Vectoria.ai
**Intelligent Graphics Generator**

A full-stack web application that uses a dual-AI pipeline to generate high-quality vector illustrations from text prompts, featuring a modern and user-friendly interface.

---

## Why Vectoria.ai?

-   **Dual-AI Power**: Leverages Google Gemini to enhance user prompts and the Recraft.ai API for stunning vector image generation.
-   **Modern User Interface**: A clean, responsive, and intuitive interface designed with a "glass morphism" aesthetic.
-   **Client-Side History**: Automatically saves your last 8 creations in your browser's local storage for easy access.
-   **Robust Backend**: Built with Node.js and Express, providing clear API endpoints and a health-check system to ensure services are online.
-   **Fallback SVG Generation**: Includes a secondary mode that uses Gemini to generate raw SVG code directly, ensuring functionality even if the primary service is unavailable.

---

## Technology Stack

-   **Backend**: Node.js, Express.js, Axios, CORS
-   **Frontend**: HTML, Tailwind CSS, Vanilla JavaScript
-   **AI APIs**:
    -   **Google Gemini**: For natural language processing and prompt enhancement.
    -   **Recraft.ai**: For primary vector illustration generation.

---

## Requirements

-   Node.js **v18+**
-   NPM (Node Package Manager)
-   **Google Gemini API Key**
-   **Recraft.ai API Key**

---

## Project Setup & Installation

### 1. File Structure

Before running, ensure your project files are organized correctly. The `package.json` file specifies that the main server script (`app.js`) should be inside a `server` directory.

```
/vectoria_ai
├── server/
│   └── app.js
├── public/
│   ├── index.html
│   └── script.js
├── .env
├── package.json
└── README.md
```

### 2. Clone the Repository

```bash
git clone <your-repository-url>
cd vectoria_ai
```

### 3. Install Dependencies

Install all the necessary npm packages listed in `package.json`.

```bash
npm install
```

### 4. Configure Environment Variables

Create a file named `.env` in the root directory of the project and add your API keys.

```env
# Get your Gemini API key from Google AI Studio
GEMINI_API_KEY=YOUR_GEMINI_API_KEY

# Get your Recraft API key from the Recraft.ai platform
RECRAFT_API_KEY=YOUR_RECRAFT_API_KEY
```

### 5. Run the Server

Start the backend server using the script defined in `package.json`.

```bash
npm start
```

The console will confirm that the server is running on `http://localhost:3001`.

### 6. Launch the Application

Open the `public/index.html` file directly in your web browser to start using the application.

---

## API Endpoints

The backend server provides the following endpoints:

### Main Generation

`POST /generate-svg`

-   **Description**: The primary endpoint. It takes a user prompt, enhances it with Gemini, and calls the Recraft.ai API to generate an image.
-   **Body**: `{ "userPrompt": "your description here" }`
-   **Response**: A JSON object containing the `imageUrl`, an enhanced `description`, and a `success` message.

### Fallback SVG Generation

`POST /generate-svg-fallback`

-   **Description**: A secondary endpoint that uses Gemini to generate raw SVG code directly.
-   **Body**: `{ "userPrompt": "your description here" }`
-   **Response**: A JSON object containing the raw `svgCode`.

### Health Check

`GET /health`

-   **Description**: Checks the server status and verifies if the `GEMINI_API_KEY` and `RECRAFT_API_KEY` have been loaded from the `.env` file. The frontend calls this on startup.
-   **Response**: `{ "status": "healthy", "apis": { "gemini": true, "recraft": true } }`

---

## Troubleshooting

-   **Connection Errors**: If the app shows a connection warning, ensure the backend server is running (`npm start`) and that no firewall is blocking port `3001`.
-   **Authentication Errors (401)**: This typically means one of your API keys in the `.env` file is incorrect or has expired. Verify your keys on their respective platforms.
-   **Rate Limit Errors (429)**: You have exceeded the usage limits for one of the APIs. Please wait or check your plan on the API provider's website.
-   **No Image Found in Response**: If Recraft.ai fails to generate an image, the server will return an error. Try rephrasing your prompt to be more specific or descriptive.

---

## License

This project is licensed under the ISC License.
