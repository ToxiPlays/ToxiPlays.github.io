//Below function is courtesy of StackOverflow
function getRandomNumber(min, max) {
    // Ensure min is less than max
    if (min > max) {
      [min, max] = [max, min]; 
    }
  
    // Generate a random number between min and max (inclusive)
    return Math.floor(Math.random() * (max - min + 1)) + min;
}


function clicked(){
    const audio = new Audio('clicksfx.wav');
    audio.play();

    if(getRandomNumber(1,100)==1) {
        console.log("you're so unlucky :(((")
        alert("I'm sorry...");
        window.location.href = "https://www.youtube.com/watch?v=At8v_Yc044Y&t=57"; //Thick Of It
    }
}