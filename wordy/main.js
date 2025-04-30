let guessList = document.querySelector(".guesses");
let answer = "";
let discoveredAnswer = "";
let wrongLetters = [];
let styled = false;
let livesNum = 0;

//fetch inital dictionary of words
let wordArray = [];
alertify.notify("Fetching words... This may take a while depending on your internet connection.");
fetch("wordlist.txt")
.then((r) => {
    if (!r.ok) {
        throw new Error(`HTTP ERROR ${r.status} FETCHING WORDS`);
    }
    return r.text();
})
.then((txt) => {
    wordArray = txt.replaceAll("\r","").split("\n");
    alertify.notify("Words fetched!");
    document.querySelector(".hidden").className = "";
    generateNewGameState();
})
.catch((e) => {
    alertify.error(`Error occured while setting up Imperfect Wordy: ${e}. Check log or talk to me. I'm awesome.`);
});


function handleInput() {
    obj = document.querySelector(".wordBox");
    if (styled) {
        obj.innerHTML = obj.textContent.replaceAll(" ","").slice(0,5).toLowerCase();
        styled = false;
    }
    let word = obj.innerText;
    if (word.includes("\n") && word != "" && word != "\n") {
        // USER TYPED NEWLINE - TIME TO PROCESS
        obj.innerHTML = word.replaceAll("\n","");
        word = word.trim().toLowerCase();
        if (word.length != 5) {
            alertify.error("Have you played Wordle before");
            return;
        }
        if (!/^[A-Za-z]+$/.test(word)) {
            alertify.error("Do you take me for a dumbass");
            return;
        }
        let commit = "";
        regenDiscoveredAnswer(word);
        if (word === answer) {
            discoveredAnswer = answer;
            commit = `<strong>${generateStyledHtml(answer, true)}</strong>`;
            let gratification = new Audio("success.wav");
            gratification.play();
            setTimeout(()=>{
                alertify.alert("Nice!",
                `You got the word (<u>${answer}</u>) in ${livesNum} guess${livesNum == 1 ? "": "es"}. Give it another go!`,
                generateNewGameState);
            },500);
        } else {
            commit = generateStyledHtml(word, true);
        }
        word.split("").forEach(c => {
            if (!answer.includes(c) && !wrongLetters.includes(c)) {
                wrongLetters.push(c);
            }
        });
        commitGuess(commit);
        livesNum++;
        obj.innerHTML = "";

        if (livesNum == 6) {
            alertify.alert("Game Over",`<strong>Out of guesses!</strong> The word was: <u>${answer}</u>. Wanna try again?`, generateNewGameState)
        }
    } else {
        obj.addEventListener("blur",commitStyledText);
    }
}

function commitStyledText() {
    obj = document.querySelector(".wordBox");
    let word = obj.innerText;
    obj.innerHTML = "";
    obj.innerHTML = generateStyledHtml(word, false);
    obj.addEventListener("focus",handleInput);
    obj.removeEventListener("blur",commitStyledText);
    styled = true;
}

function generateStyledHtml(word,barb) {
    let key = barb ? answer : discoveredAnswer;
    return word
    .split("")
    .map((c,i) => {
        if (i > 4) { return "" }; //discard more than 5 letters
        if (c === key[i]) {
            return `<span class="correct">${c}</span>`;
        } else if (key.includes(c)) {
            return `<span class="wrong-spot">${c}</span>`;
        } else if (wrongLetters.includes(c)) {
            return `<span class="incorrect">${c}</span>`;
        }
        return c;
    })
    .join("");
}

function commitGuess(html) {
    let element = document.createElement("li");
    element.innerHTML = html;
    guessList.prepend(element);
}

function regenDiscoveredAnswer(txt) {
    discoveredAnswer = txt
    .split("")
    .map((c,i) => {
        if (c === answer[i]) {
            return answer[i];
        }
        if (discoveredAnswer[i] != "_" && discoveredAnswer[i] != undefined) {
            return discoveredAnswer[i];
        }
        return "_";
    })
    .join("");
}

function generateNewGameState() {
    alertify.notify("Starting game...");
    let answerOfChoice = wordArray[Math.floor(Math.random() * wordArray.length)];
    answer = answerOfChoice;
    discoveredAnswer = "";
    livesNum = 0;
    wrongLetters = [];
    guessList.innerHTML = "";
}