"""
IFEval-FC Prompt Templates

This module contains prompt templates used for generating function call evaluation data.
It includes templates for:
1. Generating JSON schemas for AI assistant functions
2. Adding format specifications to parameter descriptions
3. Generating realistic user queries for function testing

The evaluation framework uses these prompts to create diverse test cases across
various domains to assess AI assistant function calling capabilities.
"""

# List of diverse domains for generating function call evaluation data
# These domains represent various real-world use cases where AI assistants
# might need to call functions to help users
DOMAINS: list[str] = [
    "Bookstore Assistance",
    "Airline Customer Support",
    "Retail Inventory Management",
    "Software Recommendations",
    "Navigation Assistance",
    "Shopping Recommendations",
    "Social Media Management",
    "Public Speaking Coaching",
    "Story Generation",
    "Poetry Composition",
    "Diet Planning",
    "Fitness Tracking",
    "News Summarization",
    "Pet Care Advice",
    "Gardening Tips",
    "Interior Design Advice",
    "Home Maintenance",
    "Debugging Code",
    "Summarizing Content",
    "Note Taking",
    "Brainstorming Ideas",
    "Fact Checking",
    "Research Support",
    "Technical Troubleshooting",
    "Health Symptom Checker",
    "Appointment Booking",
    "Gift Suggestion",
    "Learning New Skills",
    "Homework Help",
    "Tutoring",
    "Coding Assistance",
    "Weather Forecasting",
    "Virtual Reality Tour Guidance",
    "Sustainable Living Tips",
    "Podcast Episode Summarization",
    "Hotel Reservation Services",
    "Summarizing Articles",
    "Extracting Key Points from Reports",
    "Mental Health Support",
    "Meditation Guidance",
    "Financial Budgeting",
    "Travel Planning",
    "Job Search Assistance",
    "Resume Writing",
    "Interview Preparation",
    "Customer Support",
    "Personal Productivity",
    "Time Management",
    "Task Organization",
    "Calendar Scheduling",
    "Recipe Generation",
    "Music Recommendation",
    "Movie Recommendation",
    "Event Planning",
    "Email Composition",
    "Writing Assistance",
    "Grammar Checking",
    "Language Translation",
    "Art Critique and Feedback",
    "Personal Safety Monitoring",
    "Car Service Management",
    "Rewriting Content for Simplicity",
    "Analyzing Legal Contracts",
    "Creative Writing",
]


# Template for generating JSON schemas for AI assistant functions
# This prompt instructs an AI to create function schemas with specific requirements:
# - Each function must have one free-form parameter for natural language input
# - Each function must have at least 2 additional required parameters
# - All parameters must have proper type and description fields
GENERATE_JSON_SCHEMAS_PROMPT_TEMPLATE: str = (
    """
You are an AI-assistant in {DOMAIN}.

Your task is to generate JSON schemas for {N} functions that will be called by AI-assistant in the future to help users.

# Requirements for created functions

- Each function must include one required string parameter designed to accept free-form natural language input (referred to as the `free_form_parameter`). Examples:
  - No free-form params: `user_id`, `login` (they require specific, predefined, or strictly formatted values)
  - Free-form params: `summarized_text`, `extracted_user_problem` (they can accept lengthy, unstructured text with no strict formatting constraints)
- Except for the `free_form_parameter` each function must have at least 2 more required parameters

# Rules for creating a JSON schema:

- Make sure that every input and output parameter has an exact description (the `description` field) as well as a type (the `type` field)
- In the `required` field, specify the required parameters
- Every parameter must have a type specified: `string`, `number`, `integer`, `boolean`, `array`, or `object`
- For parameters of type `array`, there must be an `items` field—an object describing the array element (with fields `type`, `description`, and `enum` if necessary)
- If a parameter is of type `object`, you must specify a `properties` field listing all nested fields of the object. Each nested field must have a type (`type`) and a description (`description`), and, if necessary, additional attributes (`enum`, `items`). If there are required fields inside the object, add a separate `required` key with a list of their names

Example JSON schema (do not copy it in your answer):

```json
{{
  "name": "analyze_user_feedback",
  "description": "Analyzes user feedback to identify key issues, sentiments, and suggestions for product improvement.",
  "parameters": {{
    "type": "object",
    "properties": {{
      "feedback_text": {{
        "type": "string",
        "description": "User feedback such as a review, complaint, or suggestion."
      }},
      "include_sentiment": {{
        "type": "boolean",
        "description": "Whether to include sentiment analysis in the output. Defaults to False."
      }},
      "category": {{
        "type": "string",
        "enum": ["product", "service", "shipping", "billing"],
        "description": "Category of the feedback."
      }}
    }},
    "required": ["feedback_text", "category"]
  }},
  "free_form_parameter": "feedback_text"
}}
```

Output must be a single JSON array with the following structure:

```json
[
  <JSON schema 1>,
  ...
]
```

Return only the JSON response, with no additional text or formatting.
""".strip()
)

# Template for incorporating format specifications into parameter descriptions
# This prompt takes a JSON schema, parameter name, and format string, then
# updates the parameter description to include the format information naturally
ADD_FORMAT_TO_DESC_PROMPT_TEMPLATE: str = (
    """
You are given a JSON schema representing a function's description (`function_description`), the name of an input parameter (`input_param`), and a format string for this parameter.
Your task is to incorporate the format into the description of the specified parameter.
You can rephrase the original format formulation, but do not lose details and do not change its meaning.

# Input Data

[function_description]
{function_description}

[input_param]
{input_param}

[param_format]
{param_format}

Return your response strictly in the following JSON format, with no additional text:

```json
{{
    "updated_description": "The description of `input_param` with the completed format string inserted naturally (may be a separate sentence or a part of the original text)."
}}
```
""".strip()
)

# Template for generating realistic user queries to test function calling
# This prompt creates diverse, natural user messages that would trigger
# specific function calls, ensuring all required parameters can be extracted
# from the user's natural language input
GENERATE_USER_QUERIES_PROMPT_TEMPLATE: str = (
    """
You are given a function description in JSON schema format (`func_description`).

Your task is to generate exactly {N} diverse and realistic user queries that would prompt an AI assistant to call this function.
User queries must be as long as possible (if possible, use at least 100 words per user query).

Each query should reflect how a real user might naturally request the function's functionality, without any knowledge of the underlying function or its parameters.

If a value for the required parameter cannot be extracted from the user message, then it's an incorrect user message.
A value for each required parameter must be possible to extract from a user message.

For example, if required parameter is "article_text" then there should be a whole text of the article in a user message (even if it's huge).

[func_description]
{func_description}

Output only a JSON array containing the {N} user messages, formatted as follows:

```json
[
    "User message 1",
    ...
    "User message {N}"
]
```

Do not include any explanations, comments, or additional text outside the JSON array.
""".strip()
)
