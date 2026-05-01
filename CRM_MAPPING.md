# CRM Mapping Documentation

This document defines how data captured from the WhatsApp chatbot is mapped to fields in the Refrens CRM during the automated Puppeteer push.

## Field Mapping Table

| Chatbot Field | CRM Target Field | Mapping Logic | Puppeteer Selector (Example) |
| --- | --- | --- | --- |
| `contact_name` | **Contact Name** | Mapped directly. Fallbacks to `lead.name` or `"Lead-{last4}"`. | `input[placeholder="Contact Name"]`, `input[name="contact.name"]` |
| `phone_number` | **Phone** | Cleaned of +91 prefix and mapped directly. | `input[placeholder*="Phone"]`, `input[name="contact.phone"]` |
| `city` | **Customer City** | Mapped directly. Fallbacks to `"Delhi"`. | `input[placeholder="City"]`, `input[name="customer.city"]` |
| `intent_level` | **Lead Stage** | Mapped to predefined dropdown values. | `.disco-select__control` for Stage |
| `preferred_surgery_city`| **Custom Field** | Mapped to custom field label "surgery city" or "preferred city". | Custom logic matching `label` text |
| `timeline` | **Custom Field** | Mapped to custom field label "timeline". | Custom logic matching `label` text |
| `insurance` | **Custom Field** | Mapped to custom field label "insurance". | Custom logic matching `label` text |
| `remarks` / `last_user_message` | **Notes** | Injected into the primary details/notes textarea. | `textarea[placeholder*="Notes"]`, `textarea[name="details"]` |

## Lead Stage Logic

Chatbot `intent_level` values are mapped to specific CRM stages:

- **HOT** → `New`
- **WARM** → `Open`
- **COLD** → `Lost`

*(If intent level is missing, it falls back to `New`.)*

## Assignee Logic

Assignee is dynamically chosen based on intent and location:

1. **Attempt Specific**: Tries to find and select `"Senior Sales"` or `"Relive Cure"`.
2. **Hard Fallback**: If the specific assignee is not found in the DOM, it explicitly defaults to `"Relive Cure"`.

## Example Payload Transformed

**Before (Chatbot Data):**
```json
{
  "phone_number": "919876543210",
  "contact_name": "John Doe",
  "city": "Mumbai",
  "preferred_surgery_city": "Delhi",
  "timeline": "This month",
  "insurance": "Yes",
  "intent_level": "HOT",
  "last_user_message": "Can I book a consultation?"
}
```

**After (CRM Data Entered):**
- **Contact Name**: "John Doe"
- **Phone**: "9876543210"
- **Customer City**: "Mumbai"
- **Stage (Dropdown)**: "New"
- **Assignee (Dropdown)**: "Senior Sales" (or "Relive Cure")
- **Custom Field - Surgery City**: "Delhi"
- **Custom Field - Timeline**: "This month"
- **Custom Field - Insurance**: "Yes"
- **Notes Textarea**: "Can I book a consultation?"
