import puppeteer from 'puppeteer';
import 'dotenv/config';

const CRM_FORM_URL = process.env.CRM_FORM_URL || 'https://www.refrens.com/crm-form-placeholder';
const USER_DATA_DIR = './session';

async function manualLogin() {
  console.log('Launching browser for manual login...');
  console.log('Step 1: Open login page...');
  
  const browser = await puppeteer.launch({
    headless: false,
    userDataDir: USER_DATA_DIR,
    defaultViewport: null,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();
  
  // 1. Go to login page
  await page.goto("https://www.refrens.com/login", { waitUntil: "networkidle2" });
  
  console.log('Please log in manually.');
  console.log('Once logged in, I will automatically redirect you to the Lead Generation page.');

  // Wait for user to be logged in (we can detect this by checking if URL changes or some logged-in element exists, 
  // but simpler is to let the user login then we check if they are at the dashboard or a certain path)
  // Or just wait for the user to finish and let them know.
  // The prompt says "AFTER login, automatically redirect". We can wait for navigation to something other than login.
  
  await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 0 });

  console.log('Login detected. Redirecting to CRM Form URL:', CRM_FORM_URL);
  await page.goto(CRM_FORM_URL, { waitUntil: "networkidle2" });

  console.log('Successfully opened Lead page. Keeping browser open for 10 seconds to save session...');
  await new Promise(resolve => setTimeout(resolve, 10000));

  console.log('Closing browser. Session saved to:', USER_DATA_DIR);
  await browser.close();
  process.exit(0);
}

manualLogin().catch(err => {
  console.error('Error during manual login:', err);
  process.exit(1);
});
