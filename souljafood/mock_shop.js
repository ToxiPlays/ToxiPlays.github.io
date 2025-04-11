var productCarts = [];
var cartLength = 0;
var customerName = "";
var statElement = undefined;
var canUpdate = true;
var checkoutBtnClicked = 0;

const initProducts = [
    {
        "name": "Soulja Taco",
        "price": 14,
        "img": "souljaTaco.jpg"
    },
    {
        "name": "Soulja Sandwich",
        "price": 30,
        "img": "souljaSandwich.jpg"
    },
    {
        "name": "Soulja Burger",
        "price": 20,
        "img": "souljaBurger.jpg"
    },
    {
        "name": "Soulfu (Complementary)",
        "price": 0,
        "img": "soulfu.jpg"
    },
    {
        "name": "Soulja Crisps",
        "price": 25.5,
        "img": "souljaCookie.webp"
    },
    {
        "name": "Soulja Air (Experimental)",
        "price": 46.21,
        "img": "souljaAir.jpg"
    },
    {
        "name": "Soulja Pizza",
        "price": 85,
        "img": "souljaPizza.jpg"
    }
];

function getInfoWithStats() {
    //Return a string of the current cart length and customer name.
    const itemText = cartLength === 1 ? "item" : "items";
    return `You are currently "authenticated" as ${customerName}. You have ${cartLength} ${itemText} in your cart.`
}

function showCart() {
    const audio = new Audio('you.mp3');
    audio.play();

    if (!canUpdate) {
        return;
    }

    canUpdate = false;
    
    if (cartLength == 0) {
        displayString = "YOUUUUU... don't have <strong>anything</strong> in your cart.";
    } else {
        const itemText = cartLength === 1 ? "item" : "items";
        var displayString = `YOUUUUU... have ${cartLength} ${itemText} in your cart, which will cost you a total of <strong>SB${new Intl.NumberFormat('en-US', {
            style: 'currency',
            currency: 'USD'
        }).format(productCarts.reduce((total, product) => total + product.price, 0))}</strong>. `;
        
        if (cartLength == 1) {
            displayString = displayString + "That is the ";
        } else {
            displayString = displayString + "These are: ";
        }
        displayString = displayString + productCarts.map(product => `${product.name} (SB${new Intl.NumberFormat('en-US', {
            style: 'currency',
            currency: 'USD'
        }).format(product.price)})`).join(', ');
    }

    statElement.innerHTML = displayString;

    setTimeout(() => {
        canUpdate = true;
        statElement.innerHTML = getInfoWithStats();
    }, 6000);
}

// Function to open the modal and display the clicked image
function expandImage(imgElement) {
    const modal = document.getElementById("imageModal");
    const modalImg = document.getElementById("modalImage");

    modal.style.display = "flex"; // Show modal
    modalImg.src = imgElement.src; // Set modal image source to clicked image source
}

// Function to close the modal
function closeModal() {
    document.getElementById("imageModal").style.display = "none";
}

function checkout(btn) {
    checkoutBtnClicked++;
    var response = "";

    switch (checkoutBtnClicked) {
        case 1:
            response = "You can't checkout.";
            break;
        case 2:
            response = "No, really, you can't.";
            break;
        case 3:
            response = "Persistent, huh?";
            break;
        case 4:
            response = "Stop clicking this. Or else.";
            break;
        case 5:
            response = "You will leave me no choice by the 6th click.";
            break;
        case 6:
            response = "...";
            break;
        case 7:
            response = "Don't say I didn't warn you.";
            break;
        case 8:
            document.location.href = "https://www.youtube.com/watch?v=LLFhKaqnWwk";
            break;
    }

    console.warn(checkoutBtnClicked,"Checkout requested. Response generated:",response);

    btn.innerHTML = response;
    btn.disabled = true;

    setTimeout(function(){
        btn.disabled = false;
        btn.innerHTML = "Checkout";
    },2000);
}

function init() {
    customerName = prompt("Give us a username to work with!");
    if (customerName == null) {customerName = "User"};
    const body = document.querySelector(".body");
    body.style.removeProperty('display'); //remove all products
    statElement = document.querySelector("#cartSize");
    statElement.innerHTML = getInfoWithStats();
    document.querySelector("#title").innerHTML = "SouljaFood Shop";

    const productBox = document.querySelector(".products");
    //<div data-product-name = "SouljaTaco™️" data-price = "14">
    initProducts.forEach(function(i){
        var newDisplay = document.createElement("div");
        newDisplay.setAttribute("data-product-name",i["name"]);
        newDisplay.setAttribute("data-price",i["price"].toString());

        var newImg = document.createElement("img");
        newImg.setAttribute("src",i["img"]);
        newImg.setAttribute("onclick","expandImage(this)");
        newImg.setAttribute("alt",i["name"]);
        newDisplay.appendChild(newImg);

        var pTag1 = document.createElement("p");
        pTag1.setAttribute("class","productHeader");
        newDisplay.appendChild(pTag1);

        var newTxt = document.createElement("strong");
        newTxt.textContent = i["name"];
        pTag1.appendChild(newTxt);

        var priceTxt = document.createElement("span");
        priceTxt.innerHTML = ` | <span class="price"><abbr title="SB stands for SouljaBux, the national currency.">SB</abbr>${new Intl.NumberFormat('en-US', {
            style: 'currency',
            currency: 'USD'
          }).format(i["price"])}</span>`;
        pTag1.appendChild(priceTxt);

        var cartButton = document.createElement("button");
        cartButton.textContent = "Add to Cart";
        cartButton.setAttribute("data-in-cart","false");
        cartButton.setAttribute("onclick",`toggleCart(this,'${i["name"]}')`);
        cartButton.setAttribute("class","cartButton");
        newDisplay.appendChild(cartButton);

        productBox.appendChild(newDisplay);
        console.log("Created "+i["name"]);
    })
}

function toggleCart(btn,name) {
    console.log(btn,name);

    const productObject = initProducts.find(product => product.name === name);
    if (productObject == undefined) {
        console.error("Tried to find",name,"but there is no such product registered. Are we showing a dynamically generated product list?");
        alert("mock_shop.js [error]: Tried to look up product that does not seem registered, review console and code.");
        return;
    }

    if (btn.dataset.inCart == "false") {
        cartLength++;
        productCarts.push(productObject);

        btn.dataset.inCart = "true";
        btn.textContent = "Remove from Cart";
    } else if (btn.dataset.inCart == "true") {
        productCarts = productCarts.filter(product => product.name !== productObject.name);
        cartLength--;
        btn.dataset.inCart = "false";
        btn.textContent = "Add to Cart";
    } else {
        console.error("Code that isn't supposed to be reachable is very reached now. Something went wrong.");
        alert("mock_shop.js: This code shouldn't run at all -- if you're seeing this then there's an error in some logic handling, please review the code.");
        return;
    }
    if (canUpdate) {
        statElement.innerHTML = getInfoWithStats();
    }
}