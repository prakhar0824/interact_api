require("dotenv").config();
const express = require("express");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { chromium } = require("playwright");

const app = express();
app.use(express.json());

const genAI = new GoogleGenerativeAI(process.env.GOOGLE_AI_API_KEY);

// Function to interpret natural language commands
async function interpretCommand(command) {
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

    const prompt = `Convert the following natural language command into structured JSON for browser automation:
    
    Command: "${command}"

    Output JSON format should include the website, action type, and any necessary parameters.
    For example:
    {
        "website": "amazon", // The target website (e.g., amazon, google, facebook, twitter, etc.)
        "action": "login", // Action type (login, search, click, navigate, etc.)
        "parameters": {
            // For login
            "username": "user@example.com",
            "password": "password123"
            
            // For search
            "query": "search term"
            
            // For navigation
            "resultIndex": 2, // Which search result to click (0-based index)
            
            // Any other parameters needed for the action
        }
    }

    Parse the command and ensure all necessary parameters are included for the specified action.`;

    try {
        const result = await model.generateContent(prompt);
        const response = await result.response;
        let text = response.text();
    
        // Remove Markdown formatting like triple backticks and whitespace
        text = text.replace(/```json|```/g, "").trim();
    
        // Ensure JSON parsing
        try {
            return JSON.parse(text);
        } catch (jsonError) {
            console.error("JSON Parse Error:", jsonError);
            console.error("Failed JSON Text:", text); // Log the text that failed to parse
            return { error: "Failed to parse JSON: " + jsonError.message };
        }
    } catch (error) {
        console.error("Gemini API Error:", error);
        return { error: "Failed to interpret command: " + error.message };
    }
    

}


// Website-specific selectors and configurations
const websiteConfigs = {
    amazon: {
        baseUrl: "https://www.amazon.in", // Use the Indian domain
        loginPage: "https://www.amazon.in/ap/signin?openid.pape.max_auth_age=0&openid.return_to=https%3A%2F%2Fwww.amazon.in%2F%3Fref_%3Dnav_signin&openid.identity=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select&openid.assoc_handle=inflex&openid.mode=checkid_setup&openid.claimed_id=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select&openid.ns=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0",
        selectors: {
            loginEmailField: 'input[type="email"]',
            loginPasswordField: 'input[type="password"]',
            loginSubmitButton: 'input[id="signInSubmit"]',
            searchBox: 'input[id="twotabsearchtextbox"]',
            searchButton: 'input[type="submit"][value="Go"]',
            searchResults: 'div[data-component-type="s-search-result"]',
            productTitle: 'h2 a span'
        }
    },
    github: {
        baseUrl: "https://github.com",
        loginPage: "https://github.com/login",
        selectors: {
            loginEmailField: 'input[name="login"]',
            loginPasswordField: 'input[name="password"]',
            loginSubmitButton: 'input[type="submit"][name="commit"]',
            searchBox: 'input[name="q"]',
            searchResults: '.repo-list-item',
            resultTitle: 'a.v-align-middle'
        }
    },
    // Add more websites as needed
};

// Store browser context for reuse
let browserContext = null;
let activePage = null;
let waitingForHumanInput = false;

// Function to automate browser actions
async function performAction(action) {
    // Get website configuration
    const config = websiteConfigs[action.website.toLowerCase()];
    if (!config) {
        return {
            error: `Website "${action.website}" not supported. Supported websites: ${Object.keys(websiteConfigs).join(', ')}`
        };
    }

    // If we don't have an active browser context, create one
    if (!browserContext) {
        const browser = await chromium.launch({
            headless: false,
            slowMo: 50 // Slow down operations for visibility
        });
        browserContext = await browser.newContext();
    }

    // If we don't have an active page, create one
    if (!activePage) {
        activePage = await browserContext.newPage();
    }

    const page = activePage;

    try {
        // Set a reasonable timeout
        page.setDefaultTimeout(30000);

        // If we're waiting for human input from a previous action, check if this is a continue action
        if (waitingForHumanInput && action.action.toLowerCase() === "continue") {
            waitingForHumanInput = false;
            return {
                message: "Continuing automation after human intervention",
                status: "success",
                currentUrl: page.url()
            };
        }

        // Handle different action types
        switch (action.action.toLowerCase()) {
            case "login":
                return await handleLogin(page, action, config);

            case "search":
                return await handleSearch(page, action, config);

            case "navigate":
                return await handleNavigation(page, action, config);

            case "complete_flow":
                // Complete flow: login + search + navigate to a result
                const loginResult = await handleLogin(page,
                    { ...action, action: "login", parameters: action.parameters.login },
                    config);

                if (loginResult.error) return loginResult;
                if (loginResult.requiresHumanAction) return loginResult;

                const searchResult = await handleSearch(page,
                    { ...action, action: "search", parameters: action.parameters.search },
                    config);

                if (searchResult.error) return searchResult;

                return await handleNavigation(page,
                    { ...action, action: "navigate", parameters: action.parameters.navigate },
                    config);

            case "close":
                // Close browser and clear state
                if (browserContext) {
                    const browser = browserContext.browser();
                    await browserContext.close();
                    await browser.close();
                    browserContext = null;
                    activePage = null;
                    waitingForHumanInput = false;
                }
                return { message: "Browser closed", status: "success" };

            default:
                return { error: `Action "${action.action}" not supported` };
        }
    } catch (error) {
        console.error("Automation Error:", error);
        // Take screenshot of error state
        await page.screenshot({ path: `error-${Date.now()}.png` });
        return {
            error: `Automation failed: ${error.message}`,
            details: error.stack
        };
    }
}

// Handle login action
async function handleLogin(page, action, config) {
    if (!action.parameters.username || !action.parameters.password) {
        return { error: "Missing username or password for login" };
    }

    try {
        console.log(`Navigating to login page: ${config.loginPage}`);
        await page.goto(config.loginPage, { waitUntil: 'networkidle' }); // Ensure complete navigation

        // Log the current URL and content for debugging
        console.log(`Current URL: ${page.url()}`);
        console.log(`Page content: ${await page.content()}`);

        // Wait for login form
        await page.waitForSelector(config.selectors.loginEmailField);

        // Fill username/email
        await page.fill(config.selectors.loginEmailField, action.parameters.username);

        // If password field is on a different page (like Amazon)
        try {
            const continueButton = await page.$('input[id="continue"]');
            if (continueButton) {
                console.log("Continue button detected.");
                await continueButton.click();
                await page.waitForSelector(config.selectors.loginPasswordField);
            } else {
                console.log("Continue button not detected; proceeding directly to password field.");
            }
        } catch (e) {
            console.error("Error handling Continue button:", e.message);
        }

        // Fill password
        await page.fill(config.selectors.loginPasswordField, action.parameters.password);

        // Submit form
        await page.click(config.selectors.loginSubmitButton);

        // Wait for navigation to complete
        await page.waitForLoadState("networkidle");

        // Check for potential CAPTCHA or 2FA
        const url = page.url();
        const pageContent = await page.content();

        if (
            url.includes("captcha") ||
            url.includes("verify") ||
            url.includes("2fa") ||
            pageContent.includes("captcha") ||
            pageContent.includes("Captcha") ||
            pageContent.includes("human verification") ||
            pageContent.includes("security challenge")
        ) {
            // Set the flag that we're waiting for human input
            waitingForHumanInput = true;

            // Take a screenshot for reference
            await page.screenshot({ path: `captcha-${Date.now()}.png` });

            return {
                warning: "CAPTCHA or verification detected. Please complete it manually in the browser window.",
                requiresHumanAction: true,
                status: "waiting_for_human",
                currentUrl: url,
                nextStep: "After completing the CAPTCHA or verification, send a 'continue' command to resume automation."
            };
        }

        return {
            message: `Successfully logged into ${action.website}`,
            status: "success",
            currentUrl: url
        };
    } catch (error) {
        return {
            error: `Login failed: ${error.message}`,
            status: "error"
        };
    }
}

// Handle search action
async function handleSearch(page, action, config) {
    if (!action.parameters.query) {
        return { error: "Missing search query parameter" };
    }

    try {
        // If we're not already on the main page, go there
        if (!page.url().includes(config.baseUrl)) {
            await page.goto(config.baseUrl);
        }

        // Wait for search box
        await page.waitForSelector(config.selectors.searchBox);

        // Fill search query
        await page.fill(config.selectors.searchBox, action.parameters.query);

        // Submit search
        if (config.selectors.searchButton) {
            await page.click(config.selectors.searchButton);
        } else {
            // If no search button, press Enter
            await page.press(config.selectors.searchBox, 'Enter');
        }

        // Wait for results to load
        await page.waitForSelector(config.selectors.searchResults);

        // Count results
        const resultCount = await page.$$eval(config.selectors.searchResults, results => results.length);

        return {
            message: `Successfully searched for "${action.parameters.query}" on ${action.website}`,
            resultCount: resultCount,
            status: "success",
            currentUrl: page.url()
        };
    } catch (error) {
        return {
            error: `Search failed: ${error.message}`,
            status: "error"
        };
    }
}

// Handle navigation action
async function handleNavigation(page, action, config) {
    if (action.parameters.resultIndex === undefined) {
        return { error: "Missing resultIndex parameter for navigation" };
    }

    try {
        // Make sure we have search results on the page
        await page.waitForSelector(config.selectors.searchResults);

        // Get all search results
        const results = await page.$$(config.selectors.searchResults);

        if (action.parameters.resultIndex >= results.length) {
            return {
                error: `Result index ${action.parameters.resultIndex} is out of range (0-${results.length - 1})`,
                status: "error"
            };
        }

        // Get the specific result
        const targetResult = results[action.parameters.resultIndex];

        // Get the title before clicking
        let resultTitle = "";
        if (config.selectors.productTitle || config.selectors.resultTitle) {
            const titleSelector = config.selectors.productTitle || config.selectors.resultTitle;
            const titleElement = await targetResult.$(titleSelector);
            if (titleElement) {
                resultTitle = await titleElement.textContent();
            }
        }

        // Find clickable link in the result and click it
        const link = await targetResult.$('a');
        if (!link) {
            return {
                error: "No clickable link found in the selected result",
                status: "error"
            };
        }

        // Click the result
        await link.click();

        // Wait for page to load
        await page.waitForLoadState("networkidle");

        return {
            message: `Successfully navigated to result ${action.parameters.resultIndex}${resultTitle ? `: "${resultTitle.trim()}"` : ''}`,
            status: "success",
            currentUrl: page.url()
        };
    } catch (error) {
        return {
            error: `Navigation failed: ${error.message}`,
            status: "error"
        };
    }
}

// API endpoint for interaction
app.post("/interact", async (req, res) => {
    const { command } = req.body;
    if (!command) {
        return res.status(400).json({
            error: "Missing command",
            status: "error"
        });
    }

    try {
        // If command is "continue", handle it directly
        if (command.toLowerCase() === "continue") {
            const result = await performAction({ action: "continue" });
            return res.json(result);
        }

        // If command is "close browser", handle it directly
        if (command.toLowerCase().includes("close browser")) {
            const result = await performAction({ action: "close" });
            return res.json(result);
        }

        // Interpret the natural language command
        const action = await interpretCommand(command);

        if (action.error) {
            return res.status(500).json({
                error: action.error,
                status: "error"
            });
        }

        // Perform the requested action
        const result = await performAction(action);
        res.json(result);
    } catch (error) {
        console.error("Server Error:", error);
        res.status(500).json({
            error: `Server error: ${error.message}`,
            status: "error"
        });
    }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Browser Automation Agent running on port ${PORT}`));
