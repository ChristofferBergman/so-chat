let CONFIG = {};

document.addEventListener("DOMContentLoaded", function () {
    const input = document.getElementById("question");
    input.addEventListener("keydown", function (event) {
        if (event.key === "Enter") {
            event.preventDefault(); // prevent form submission / newline
            postQuestion();
        }
    });

    // You can still open the login modal here too
    openLoginModal();
});

function openLoginModal() {
    document.getElementById("loginModal").style.display = "block";
}

function closeLoginModal() {
    document.getElementById("loginModal").style.display = "none";
}

function saveConfig() {
    CONFIG = {
        server: document.getElementById("neo4jServer").value,
        user: document.getElementById("neo4jUser").value,
        password: document.getElementById("neo4jPassword").value,
        apiKey: document.getElementById("openAiApiKey").value
    };
    closeLoginModal();
    alert("Authentication saved!");
}

async function postQuestion() {
    const question = document.getElementById("question").value;
    if (!question) {
        alert("Please enter a question.");
        return;
    }
    if (!CONFIG.server || !CONFIG.user || !CONFIG.password || !CONFIG.apiKey) {
        alert("Please enter and save the configuration first.");
        return;
    }

    try {
        document.getElementById("answer").value = "Fetching context...";
        
        const result = await queryNeo4j(question);
        const context =  result.records.length ? result.records[0].get("context") : "";
        if (!context) {
            document.getElementById("answer").value = "No relevant context found.";
            return;
        }
        document.getElementById("answer").value = "Asking LLM...";
        const answer = await queryOpenAI(context, question);
        document.getElementById("answer").value = answer;
    } catch (error) {
        console.error("Error:", error);
        document.getElementById("answer").value = "An error occurred while processing your request.";
    }
}

async function queryNeo4j(question) {
    const driver = neo4j.driver(
        CONFIG.server,
        neo4j.auth.basic(CONFIG.user, CONFIG.password)
    );
    const session = driver.session();
    
    try {
        const result = await session.run(
            `WITH genai.vector.encode($question, "OpenAI", {token: $apiKey}) AS embedding
            CALL db.index.vector.queryNodes('post_embeddings', 2, embedding) YIELD node AS p, score AS pscore
            MATCH (p)((:Post)-[:PARENT]->(:Post))*(parent)
            WITH embedding, collect(parent) AS parents
            CALL db.index.vector.queryNodes('title_embeddings', 2, embedding) YIELD node AS q, score AS qscore
            WITH parents, collect(q) AS posts
            WITH parents+posts AS questions

            UNWIND questions AS question
            MATCH path = (question)((:Post)<-[:PARENT]-(:Post))*
            WITH question, nodes(path) AS posts

            UNWIND posts AS post
            OPTIONAL MATCH (post)<-[:ON_POST]-(comment:Comment)
            WITH DISTINCT comment, post, question
            WITH question, post, COLLECT(comment.text) AS comments

            WITH
                CASE
                    WHEN post = question THEN '***QUESTION***\nTitle: ' + post.title + '\nBody: ' + post.body
                    ELSE '***ANSWER***\nBody: ' + post.body
                END
            +
                CASE
                    WHEN SIZE(comments) > 0 THEN '\n***COMMENT***\n' + apoc.text.join(comments, '\n***COMMENT***\n')
                    ELSE ''
                END
            AS postText


            WITH DISTINCT postText
            RETURN apoc.text.join(COLLECT(postText), '\n\n') AS context`,
            { question, apiKey: CONFIG.apiKey }
        );
        return result;
    } catch (error) {
        console.error("Neo4j query error:", error);
        return null;
    } finally {
        await session.close();
        await driver.close();
    }
}

async function queryOpenAI(context, question) {
    const url = "https://api.openai.com/v1/chat/completions";
    const payload = {
        model: "gpt-4",
        messages: [{
            role: "system",
            content: `Answer the following Question based on the Context only. Only answer from the Context. If you don't know the answer, say 'I don't know'. The context is a list of posts and comments, separated by headers in the form of ***QUESTION***, ***ANSWER*** and ***COMMENT***.\n\nContext: ${context}\n\nQuestion: ${question}`
        }],
        max_tokens: 500
    };
    
    const response = await fetch(url, {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${CONFIG.apiKey}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
    });
    
    const data = await response.json();
    return data.choices?.[0]?.message?.content || "No response from OpenAI.";
}
